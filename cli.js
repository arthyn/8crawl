#!/usr/bin/env node

const puppeteer = require('puppeteer');
const path = require('path');
const fs = require('fs');
const prependFile = require('prepend-file');

const cache = [];
const download = true;
const cacheFile = 'cache.txt';

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
	const browser = await puppeteer.launch({ headless: true });
	const page = await browser.newPage();

	await collectData(page);
	saveCollectedData();
})();

function exitIfReady({ cacheWritten, mixesSaved }) {
	if (cacheWritten && mixesSaved)
		process.exit(0);
}

async function getLinks(page, pageUrl, selector) {
	try {
		await page.goto(pageUrl);

		console.log(`opened the page: ${pageUrl}`);
		await page.waitForSelector(selector, { timeout: 5000 });
	} catch (error) {
		console.log(`failed to open the page: ${pageUrl} with the error: ${error}`);
	}

	return await page.$$eval(selector, postLinks => postLinks.map(link => link.href));
}

async function getData(page, collection) {
	let pageData = {};

	pageData.collection = collection;
	pageData.name = await page.$$eval('#mix_name', title => title[0].textContent.trim());
	pageData.user = await page.$$eval('#user_byline .propername', user => user[0].textContent.trim());
	pageData.date = await page.$$eval('.mix-data .datetime', date => date[0].textContent.trim());
	pageData.numberOfTracks = await page.$$eval('#tracks_count', count => count[0].textContent.trim());
	pageData.tags = await page.$$eval('#mix_tags_display .tag', tags => tags.map(tag => tag.textContent.trim()));
	pageData.notes = await page.$$eval('#description_html', description => {
		const text = description[0].textContent;
		const trimmedNotes = text.substring(0, text.indexOf('Download Tracklist'));
		return trimmedNotes.trim();
	});
	
	cache.push(pageData);
}

async function processPage(page, pageUrl, collection) {
	try {
		await page.goto(pageUrl);
		console.log(`opened the page: ${pageUrl}`);

		await getData(page);
		download && await downloadFromPage(page);
	} catch (error) {
		console.log(`failed to process the page: ${pageUrl} with the error: ${error}`);
	}	
}

async function downloadFromPage(page) {
	await page._client.send('Page.setDownloadBehavior', {
		behavior: 'allow', 
		downloadPath: path.resolve(cwd, dir)
	});

	const selector = '.download_tracklist';
	await page.waitForSelector(selector, { timeout: 5000 });
	await page.click(selector);
	await page.waitFor(50);
}

async function collectData(page) {
	let count, total, mixUrls,
	currentPage = 2;

	do {
		mixUrls = await getLinks(page, pageUrl + currentPage, '.cover a.mix_url');
		count = 1;
		total = mixUrls.length;
		console.log(`Going through ${total} mixes from page ${currentPage}`);

		for (let mix of mixUrls) {
			console.log(`Processing ${count} of ${total}`);
			await processPage(page, mix);
			count++;
		}

		currentPage += 2;
	} while (mixUrls.length > 0)
}

function transformMixData(mix) {
	return `${mix.name}
by ${mix.user}
tags: ${mix.tags.join(', ')}

${mix.notes}\n`;
}

async function saveMixData(mix, data) {
	return new Promise((resolve, reject) => {
		const mixName = `8tracks-${mix.user}-${mix.name}.txt`;
		const mixPath = path.resolve(cwd, dir, mixName.replace(/[>:'"\|\*\\\/\?]/g, '_'));

		prependFile(mixPath, data, (err) => {
			if (err) {
				console.log(`Failed to write ${mix.name} data to ${mixPath}.`);
				reject(err);
			}
				
			console.log(`Wrote ${mix.name} data to ${mixPath}`);
			resolve();
		});
	});
}

function writeToCache(processData) {
	const cachePath = path.resolve(cwd, dir, cacheFile);
	let cacheData = '';
	processData.dataToProcess.forEach(item => cacheData += item.data);

	try {
		fs.writeFileSync(cachePath, cacheData);
		console.log(`Cache saved.`);
		processData.cacheWritten = true;
	} catch (error) {
		console.log(`Failed to write cache data to ${cachePath}.\n${error}`);
	}

	exitIfReady(processData);
}

function saveCollectedData() {
	let cacheWritten = false;
	let mixesSaved = false;
	let dataToProcess = cache.map(mix => ({
		mix,
		data: transformMixData(mix)
	}));
	let processData = {
		dataToProcess,
		cacheWritten,
		mixesSaved
	};
	
	Promise.all(dataToProcess.map(item => saveMixData(item.mix, item.data).catch((err) => console.log(err))))
		.then(() => {
			processData.mixesSaved = true;
			exitIfReady(processData)
		})

	writeToCache(processData);
}

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