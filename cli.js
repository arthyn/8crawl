#!/usr/bin/env node

const path = require('path');
const { promisify } = require('util')
const fs = require('fs');
const writeFile = promisify(fs.writeFile);
const axios = require('axios');
const cheerio = require('cheerio');
const map = require('async/mapLimit');
const AWS = require('aws-sdk');
const s3 = new AWS.S3();
const sanitize = require('sanitize-filename');
const admZip = require('adm-zip');

const prependFile = require('prepend-file');

const cache = [];
const download = true;
const cacheFile = 'cache.txt';
const hostName = 'https://8tracks.com';
const bucket = 'hcrawl';
const mixHandler = 'https://rytphgcpea.execute-api.us-east-1.amazonaws.com/dev/mix/download';

const [,,...args] = process.argv;
const pageUrl = args[0];
const dir = args[1] || 'tmp';
const cwd = process.cwd();

if (!pageUrl) {
	console.log('Please enter a listen history url.')
	process.exit(0)
}

if (!fs.existsSync(dir)){
    fs.mkdirSync(dir);
}

(async() => {
	const filesToZip = await collectData();
	saveCollectedData(filesToZip);
})();

function exitIfReady({ cacheWritten, mixesSaved }) {
	if (cacheWritten && mixesSaved)
		process.exit(0);
}

async function getLinks(pageUrl, selector) {
	let response;

	try {
		response = await axios.get(pageUrl);
		console.log(`opened the page: ${pageUrl}`);
	} catch (error) {
		console.log(`failed to open the page: ${pageUrl} with the error: ${error}`);
		return [];
	}

	const $ = cheerio.load(response.data);
	return $(selector).map((i, el) => $(el).attr('href')).get();
}

async function collectData() {
	let pageUrls, pageRequests,
	mixUrls = [],
	promises = [],
	currentPage = 1,
	count = 1,
	total = 0;

	do {
		pageUrls = await getLinks(pageUrl + '/' + currentPage, '.cover a.mix_url');
		console.log(pageUrls);

		if (pageUrls.length) {
			total += pageUrls.length;
			mixUrls = mixUrls.concat(pageUrls);

			pageRequests = pageUrls.map(mix => ({
				pageUrl: hostName + mix, 
				count: count++, 
				total: total
			}));

			promises.push(map(pageRequests, 50, downloadMix));
		}

		currentPage++;
	} while (pageUrls.length > 0)


	console.log(`Going through ${total} mixes from page ${currentPage}`);

	return Promise.all(promises).then(set => set.flat());
}

async function downloadMix(request) {
	try {
		console.log(`Processing ${request.count} of ${request.total}`);
		const response = await axios.post(mixHandler, request);
		const file = response.data;
		let fileData = null;

		if (file != null) {
			fileData = await s3.getObject({
				Bucket: bucket,
				Key: file
			}).promise();
		}

		return { file, fileData: fileData.Body };
	} catch (error) {
		console.log(request, error.message);
		console.log(error.stack);

		if (error.response) {
			console.log(error.response.data);
		}
		
		return { file: null, fileData: null };
	}
}

function saveCollectedData(files) {
	const zip = new admZip();
	files.forEach(item => {
		if (item.file != null && typeof item.fileData !== 'undefined')
			zip.addFile(sanitize(item.file), Buffer.alloc(item.fileData.length, item.fileData));
	});

	zip.writeZip(path.resolve(cwd, dir, 'archive.zip'));
}

// function transformMixData(mix) {
// 	return `${mix.name}
// by ${mix.user}
// tags: ${mix.tags.join(', ')}

// ${mix.notes}\n`;
// }

// async function saveMixData(mix, data) {
// 	return new Promise((resolve, reject) => {
// 		const mixName = `8tracks-${mix.user}-${mix.name}.txt`;
// 		const mixPath = path.resolve(cwd, dir, mixName.replace(/[>:'"\|\*\\\/\?]/g, '_'));

// 		prependFile(mixPath, data, (err) => {
// 			if (err) {
// 				console.log(`Failed to write ${mix.name} data to ${mixPath}.`);
// 				reject(err);
// 			}
				
// 			console.log(`Wrote ${mix.name} data to ${mixPath}`);
// 			resolve();
// 		});
// 	});
// }

// function writeToCache(processData) {
// 	const cachePath = path.resolve(cwd, dir, cacheFile);
// 	let cacheData = '';
// 	processData.dataToProcess.forEach(item => cacheData += item.data);

// 	try {
// 		fs.writeFileSync(cachePath, cacheData);
// 		console.log(`Cache saved.`);
// 		processData.cacheWritten = true;
// 	} catch (error) {
// 		console.log(`Failed to write cache data to ${cachePath}.\n${error}`);
// 	}

// 	exitIfReady(processData);
// }

// function saveCollectedData() {
// 	let cacheWritten = false;
// 	let mixesSaved = false;
// 	let dataToProcess = cache.map(mix => ({
// 		mix,
// 		data: transformMixData(mix)
// 	}));
// 	let processData = {
// 		dataToProcess,
// 		cacheWritten,
// 		mixesSaved
// 	};
	
// 	Promise.all(dataToProcess.map(item => saveMixData(item.mix, item.data).catch((err) => console.log(err))))
// 		.then(() => {
// 			processData.mixesSaved = true;
// 			exitIfReady(processData)
// 		})

// 	writeToCache(processData);
// }

/*

	const pageUrl = 'https://8tracks.com/users/electinae/collections';
	const collectionUrls = await getLinks(page, pageUrl, '.collection_list .title a');	

	let count, total;

	for (let collection of collectionUrls) {
		const collectionDir = collection.substr(collection.lastIndexOf('/') + 1);
		const mixUrls = await getLinks(page, collection, '.cover a.mix_url');
		console.log(`Going through ${mixUrls.length} mixes from ${collectionDir}`);
		count = 1;
		total = mixUrls.length;

		for (let mix of mixUrls) {
			console.log(`Processing ${count} of ${total}`);
			await processPage(page, mix, collectionDir);
			count++;
		}
	}

*/