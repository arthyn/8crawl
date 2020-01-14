'use strict';

const uuid = require('uuid/v4');
const AWS = require('aws-sdk');
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
			await lambda.invoke({ ...lambdaParams, FunctionName: 'processHistory' }).promise();
		} else if (data.type === 'collection') {
			await lambda.invoke({ ...lambdaParams, FunctionName: 'processCollection' }).promise();
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