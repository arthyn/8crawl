const axios = require('axios');
const cheerio = require('cheerio');
const map = require('async/mapLimit');
const aws = require('aws-sdk');
const awsXRay = require('aws-xray-sdk');
const AWS = process.env.IS_LOCAL ? aws : awsXRay.captureAWS(aws);
const db = new AWS.DynamoDB.DocumentClient();
const lambda = new AWS.Lambda({
	endpoint: process.env.SLS_DEBUG
    ? 'http://localhost:3000'
    : 'https://lambda.us-east-1.amazonaws.com',
});

const hostName = 'https://8tracks.com';

module.exports.process = async event => {
	const data = typeof event.body === 'string' ? JSON.parse(event) : event;
	const success = await collectData(data);

	if (!success)
		return { statusCode: 500, body: 'failed' };

	return {
		statusCode: 200,
		body: 'success'
	}
}

async function collectData(data) {
	let pageRequests,
	currentPage = data.currentPage || 1,
	count = data.count || 1,
	total = data.total || 0;

	const pageUrls = await getLinks(data.url + '/' + currentPage, '.cover a.mix_url');
	console.log(pageUrls);

	try {
		if (pageUrls == null) {
			return false;
		} else if (pageUrls.length) {
			const response = await updateUrlList(pageUrls, data.id);
			total = response.Attributes.Mixes.values.length;
	
			pageRequests = pageUrls.map(mix => ({
				url: hostName + mix, 
				count: count++, 
				total,
				id: data.id
			}));
	
			await map(pageRequests, 50, downloadMix);
			await processNextPage({
				url: data.url,
				id: data.id,
				currentPage: ++currentPage,
				count,
				total
			})
		} else {
			await recordTotal(total, data.id);
		}

		return true;
	} catch (error) {
		console.log(error, error.stack);
		return false;
	}
}

async function getLinks(pageUrl, selector) {
	let response;

	try {
		response = await axios.get(pageUrl);
		console.log(`opened the page: ${pageUrl}`);
	} catch (error) {
		console.log(`failed to open the page: ${pageUrl} with the error: ${error}`);
		return null;
	}

	const $ = cheerio.load(response.data);
	return $(selector).map((i, el) => $(el).attr('href')).get();
}

async function downloadMix(request) {
	await lambda.invoke({
		FunctionName: 'hcrawl-dev-downloadMix',
		InvocationType: 'Event',
		LogType: 'Tail',
		Payload: JSON.stringify(request)
	}).promise();
}

async function processNextPage(request) {
	await lambda.invoke({
		FunctionName: 'hcrawl-dev-processHistory',
		InvocationType: 'Event',
		LogType: 'Tail',
		Payload: JSON.stringify(request)
	}).promise();
}

async function updateUrlList(urls, id) {
	return await db.update({
		TableName: 'ArchiveRequests',
		Key: {
			RequestId: id
		},
		ExpressionAttributeValues: {
			":urls": db.createSet(urls)
		},
		UpdateExpression: "ADD Mixes :urls",
		ReturnValues: "UPDATED_NEW"
	}).promise();
}

async function recordTotal(total, id) {
	await db.update({
		TableName: 'ArchiveRequests',
		Key: {
			RequestId: id
		},
		ExpressionAttributeValues: {
			":total": total.toString()
		},
		UpdateExpression: "SET TotalMixes = :total"
	}).promise();
}
