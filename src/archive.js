'use strict';

const uuid = require('uuid/v4');
const AdmZip = require('adm-zip');
const AWS = require('aws-sdk');
const map = require('async/mapLimit');
const s3 = new AWS.S3();
const db = new AWS.DynamoDB();
const lambda = new AWS.Lambda({
	endpoint: process.env.DEV
    ? 'http://localhost:3000'
    : 'https://lambda.us-east-1.amazonaws.com',
});

module.exports.request = async event => {
	const data = typeof event.queryStringParameters === 'string' ? JSON.parse(event.queryStringParameters) : event.queryStringParameters;
	const id = uuid();

	try {
		const response = await db.putItem({
			TableName: 'ArchiveRequests',
			Item: {
				RequestId: { "S": id },
				Url: { "S": data.url },
				Type: { "S": data.type },
				Created: { "N": Date.now().toString() }
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
			body: 'Unable to initiate archive request.'
		};
	}

	return {
		statusCode: 200,
		body: JSON.stringify(id)
	}	
}

module.exports.download = async event => {
	const data = typeof event.queryStringParameters === 'string' ? JSON.parse(event.queryStringParameters) : event.queryStringParameters;
	const id = data.id;
	if (id == null)
		return { 
			statusCode: 500, 
			body: {
				message: 'Unable to find archive.'
			}
		}
	
	const downloads = await getDownloads(id);
	const isAvailable = await checkIfArchiveReady(id, downloads);
	if (!isAvailable)
		return { statusCode: 500, body: { message: 'Not ready.' } }

	const zip = createZip(downloads);
	const fileName = await uploadZip(zip);
	if (fileName == null)
		return { statusCode: 500, body: { message: 'Unable to upload zip.'} }

	const signedUrl = getSignedUrl(filename);
	return {
		statusCode: 200,
		body: {
			url: signedUrl,
			message: 'success'
		}
	}
}

async function getDownloads(id) {
	const downloadItems = await db.batchGetItem({
		RequestItems: {
			ArchiveDownloads: {
				Keys: {
					RequestId: { S: id }
				}
			}
		}
	}).promise();

	return await map(downloadItems, 50, getDownload);
}

async function checkIfArchiveReady(id, downloads) {
	const request = await db.getItem({
		TableName: 'ArchiveRequests',
		Keys: {
			RequestId: { S: id }
		}
	}).promise();

	return request.TotalMixes === downloads.length;
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
	const errors = downloads.filter(item => item.File !== 'error');
	const errorFile = { file: 'errored.txt', fileData: errors.map(item => item.fileData).join('\n') };

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