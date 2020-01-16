const axios = require('axios');
const cheerio = require('cheerio');
const map = require('async/mapLimit');
const awsXRay = require('aws-xray-sdk');
const AWS = awsXRay.captureAWS(require('aws-sdk'));
const db = new AWS.DynamoDB();
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
			total += pageUrls.length;
	
			pageRequests = pageUrls.map(mix => ({
				url: hostName + mix, 
				count: count++, 
				total: total,
				id: data.id
			}));
	
			await map(pageRequests, 50, downloadMix);
			await updateUrlList(pageUrls, data.id);
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
	await db.updateItem({
		TableName: 'ArchiveRequests',
		Key: {
			RequestId: { "S": id }
		},
		ExpressionAttributeValues: {
			":urls": { "SS": urls }
		},
		UpdateExpression: "ADD Mixes :urls"
	}).promise();
}

async function recordTotal(total, id) {
	await db.updateItem({
		TableName: 'ArchiveRequests',
		Key: {
			RequestId: { "S": id }
		},
		ExpressionAttributeValues: {
			":total": { "N": total.toString() }
		},
		UpdateExpression: "SET TotalMixes = :total"
	}).promise();
}
