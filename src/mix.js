'use strict';

const awsXRay = require('aws-xray-sdk');
const AWS = awsXRay.captureAWS(require('aws-sdk'));
const s3 = new AWS.S3();
const db = new AWS.DynamoDB();
const chromium = require('chrome-aws-lambda');
let browser;

module.exports.download = async event => {
  let data;
  if (typeof event.body === 'undefined') {
    data = event;
  } else if (typeof event.body === 'string') {
    data = JSON.parse(event.body)
  } else {
    data = event.body;
  }
  console.log(data, event);

  const result = await processPage(data);
  if (result == null)
    return { statusCode: 500, body: 'Unable to process ' + data.pageUrl };

  const savedFile = await checkAndSaveFile({ ...result, data });
  if (savedFile == null)
    return { statusCode: 500, body: 'Unable to save ' + result.name };

  return {
    statusCode: 200,
    body: JSON.stringify(savedFile),
  };
};

async function processPage({ url, count, total }) {
	try {
    browser = browser || await chromium.puppeteer.launch({
      executablePath: await chromium.executablePath,
      args: chromium.args.concat(['--disable-dev-shm-usage']),
      defaultViewport: chromium.defaultViewport,
      headless: chromium.headless,
    });
		const page = await browser.newPage();
		await page.goto(url);
		console.log(`Processing ${count} of ${total}`);
		console.log(`opened the page: ${url}`);
		
		const data = await getData(page);
		const tracks = await downloadFromPage(page);
    await page.close();

    return { mix: data, tracks };
	} catch (error) {
    console.log(`failed to process the page: ${url} with the error: ${error}`);
    return null;
	}	
}

async function getData(page, collection) {
	let pageData = {};

	pageData.collection = collection;
	pageData.name = await page.$$eval('#mix_name', title => title[0].textContent.trim());
	pageData.user = await page.$$eval('#user_byline .propername', user => user[0].textContent.trim());
	pageData.tags = await page.$$eval('#mix_tags_display .tag', tags => tags.map(tag => tag.textContent.trim()));
	pageData.notes = await page.$$eval('#description_html', description => {
		const text = description[0].textContent;
		const trimmedNotes = text.substring(0, text.indexOf('Download Tracklist'));
		return trimmedNotes.trim();
	});
	
	return pageData;
}

async function downloadFromPage(page) {
  // const selector = '.download_tracklist';
	// await page.waitForSelector(selector, { timeout: 1500 });
	// await page.click(selector);

  let tracks = undefined;
  for (let i=0;i < 3;i++) {
    tracks = await page.evaluate(() => {
      return new Promise((resolve, reject) => {
        let view = window.App.views.mixView;
        let savedTracks = undefined;

        //view was undefined so eject
        if (typeof view === 'undefined') {
          resolve(undefined);
          return;
        }
        
        if (view.mix.tracks && view.mix.tracks.models) {
          savedTracks = view.mix.tracks.models.map(model => model.attributes);
          resolve(savedTracks);
        } else {
          view.mix.withInternationalTracks(() => {
            savedTracks = view.mix.tracks.models.map(model => model.attributes);
            resolve(savedTracks);
          }).fail(() => resolve(undefined));

          setTimeout(() => resolve(undefined), 350);
        }
      })
    });
    
    if (typeof tracks !== 'undefined')
      break;
    console.log(i, tracks);
  }

  return tracks;
}

async function checkAndSaveFile({ mix, tracks, data }) {
  try {
    if (typeof mix === 'undefined' || typeof tracks === 'undefined')
      throw new Error('Missing mix or tracks data.');

    const mixData = Buffer.from(transformMixData({ mix, tracks }));
    const fileName = `${mix.user}-${mix.name}.txt`.replace('/', '_');

    const s3Response = await s3.putObject({
      Bucket: process.env.BUCKET,
      Key: fileName,
      Body: mixData,
      ContentType: 'binary', 
      ContentEncoding: 'utf8'
    }).promise();
    console.log('Successfully uploaded', fileName);

    await recordDownload({ ...data, fileName });

    return s3Response != null ? fileName : null;
  } catch (error) {
    console.log(error, error.stack);
    return null;
  }  
}

function transformMixData({ mix, tracks}) {
	const top = `${mix.name}
by ${mix.user}
tags: ${mix.tags.join(', ')}

${mix.notes}\n\n`;
  let bottom = '';
  tracks.forEach((track, index) => {
    bottom += `${index + 1}. ${track.name} by ${track.performer}\n`;
  });

  return top + bottom;
}

async function recordDownload(download) {
  console.log(download)
  const response = await db.putItem({
    TableName: 'ArchiveDownloads',
    Item: {
      RequestId: { "S": download.id },
      MixUrl: { "S": download.url },
      File: { "S": download.fileName },
      Created: { "N": Date.now().toString() }
    }
  }).promise();

  if (response.err)
    throw new Error(response.err);
}