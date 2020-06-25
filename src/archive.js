'use strict';

const uuid = require('uuid/v4');
const AdmZip = require('adm-zip');
const sanitize = require('sanitize-filename');
const aws = require('aws-sdk');
const awsXRay = require('aws-xray-sdk');
const AWS = process.env.IS_LOCAL ? aws : awsXRay.captureAWS(aws);
awsXRay.setContextMissingStrategy("LOG_ERROR");
const map = require('async/mapLimit');
const s3Config = !process.env.SLS_DEBUG ? {} : {
    s3ForcePathStyle: true,
    accessKeyId: 'S3RVER', // This specific key is required when working offline
    secretAccessKey: 'S3RVER',
    endpoint: new AWS.Endpoint('http://localhost:8001'),
  }
const s3 = new AWS.S3(s3Config);
const db = new AWS.DynamoDB.DocumentClient();
const lambda = new AWS.Lambda({
	endpoint: process.env.SLS_DEBUG
    ? 'http://localhost:3000'
    : 'https://lambda.us-east-1.amazonaws.com',
});

module.exports.request = async event => {
	const data = typeof event.queryStringParameters === 'string' ? JSON.parse(event.queryStringParameters) : event.queryStringParameters;
	const id = uuid();

	try {
		const response = await db.put({
			TableName: 'ArchiveRequests',
			Item: {
				RequestId: id,
				Url: data.url,
				Type: data.type,
				Created: Date.now().toString()
			}
		}).promise();
	
		if (response.err)
			throw response.err

		const lambdaParams = {
			InvocationType: 'Event',
			LogType: 'Tail',
			Payload: JSON.stringify({
				url: data.url,
				id
			})
		}

		if (data.type === 'history') {
			await lambda.invoke({ ...lambdaParams, 
			FunctionName: 'hcrawl-dev-processHistory',
		}).promise();
		} else if (data.type === 'collection') {
			await lambda.invoke({ ...lambdaParams, FunctionName: 'hcrawl-dev-processCollection' }).promise();
		}
		
	} catch (error) {
		console.log(error, error.stack);

		return {
			statusCode: 500,
			body: 'Unable to initiate archive request.',
			headers: {
			  'Access-Control-Allow-Origin': '*',
			  'Access-Control-Allow-Credentials': true,
			}
		};
	}

	return {
		statusCode: 200,
		body: JSON.stringify(id),
		headers: {
		  'Access-Control-Allow-Origin': '*',
		  'Access-Control-Allow-Credentials': true,
		}
	}	
}

module.exports.download = async event => {
	const data = typeof event.queryStringParameters === 'string' ? JSON.parse(event.queryStringParameters) : event.queryStringParameters;
	const id = data.id;
	console.log(data);
	if (id == null)
		return { 
			statusCode: 500, 
			body: JSON.stringify({
				message: 'Unable to find archive.'
			})
		}
	console.log(await s3.listObjects({
		Bucket: 'hcrawl'
	}).promise());
	const downloads = await getDownloads(id);
	const readyData = await checkIfArchiveReady(id, downloads);
	if (!readyData.ready)
		return { 
			statusCode: 200, 
			body: JSON.stringify({ 
				message: 'Not ready.',
				...readyData
			}),
			headers: {
			  'Access-Control-Allow-Origin': '*',
			  'Access-Control-Allow-Credentials': true,
			} 
		}

	const zip = createZip(downloads);
	const fileName = await uploadZip(id, zip);
	if (fileName == null)
		return { 
			statusCode: 500, 
			body: JSON.stringify({ message: 'Unable to upload zip.'}),
			headers: {
			  'Access-Control-Allow-Origin': '*',
			  'Access-Control-Allow-Credentials': true,
			}
		}

	const signedUrl = getSignedUrl(fileName);
	return {
		statusCode: 200,
		body: JSON.stringify({
			url: signedUrl,
			message: 'success',
			...readyData
		}),
		headers: {
		  'Access-Control-Allow-Origin': '*',
		  'Access-Control-Allow-Credentials': true,
		}
	}
}

async function getDownloads(id) {
	const downloadItems = await db.query({
		TableName: 'ArchiveDownloads',
		KeyConditionExpression: 'RequestId = :requestId',
		ExpressionAttributeValues: {
			':requestId': id
		}
	}).promise();

	if (downloadItems == null)
		return null;

	return await map(downloadItems.Items, 50, getDownload);
}

async function checkIfArchiveReady(id, downloads) {
	const request = await db.get({
		TableName: 'ArchiveRequests',
		Key: {
			RequestId: id
		}
	}).promise();

	return {
		ready: request != null && request.Item.TotalMixes == downloads.length,
		total: request.Item.TotalMixes,
		count: downloads.length
	};
}

async function getDownload(download) {
	try {
		const response = await s3.getObject({
			Bucket: 'hcrawl',
			Key: download.File
		}).promise();

		return {
			...download,
			fileData: response.Body
		}
	} catch (error) {
		console.log(error, error.stack);
		return {
			...download,
			File: 'error'
		}
	}
}

function createZip(downloads) {
	const zip = new AdmZip();
	const errors = downloads.filter(item => item.File === 'error');
	const errorFile = { File: 'errored.txt', fileData: errors.map(item => item.fileData).join('\n') };

	if (errors.length > 0)
		zip.addFile(errorFile.file, Buffer.alloc(errorFile.fileData.length, errorFile.fileData));

	downloads.forEach(item => {
		if (item.File != null && typeof item.fileData !== 'undefined')
			zip.addFile(sanitize(item.File), Buffer.alloc(item.fileData.length, item.fileData));
	});

	return zip.toBuffer();
}

async function uploadZip(id, zip) {
	const archiveName = `history-archive-${id}.zip`;

	try {
		const response = await s3.putObject({
			Bucket: process.env.BUCKET,
			Key: archiveName,
			Body: zip,
			ContentType: 'binary', 
			ContentEncoding: 'utf8'
		}).promise();
	
		console.log('Successfully uploaded', archiveName);

		return response != null ? archiveName : null;
	} catch (error) {
		console.log(error, error.stack);
		return null;
	}
}

function getSignedUrl(file) {
	return s3.getSignedUrl('getObject', {
		Bucket: process.env.BUCKET,
		Key: file
	});
}