'use strict';

const AWS = require('aws-sdk');
const s3 = new AWS.S3();
const db = new AWS.DynamoDB();
const chromium = require('chrome-aws-lambda');
let browser;

module.exports.download = async event => {
  const data = typeof event.body === 'string' ? JSON.parse(event.body) : event.body;
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

async function processPage({ pageUrl, count, total }) {
	try {
    browser = browser || await chromium.puppeteer.launch({
      executablePath: await chromium.executablePath,
      args: chromium.args.concat(['--disable-dev-shm-usage']),
      defaultViewport: chromium.defaultViewport,
      headless: chromium.headless,
    });
		const page = await browser.newPage();
		await page.goto(pageUrl);
		console.log(`Processing ${count} of ${total}`);
		console.log(`opened the page: ${pageUrl}`);
		
		const data = await getData(page);
		const tracks = await downloadFromPage(page);
    await page.close();

    return { mix: data, tracks };
	} catch (error) {
    console.log(`failed to process the page: ${pageUrl} with the error: ${error}`);
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
  let tracks = undefined;
  for (let i=0;i < 5;i++) {
    await page.waitFor(90);
    tracks = await page.evaluate(() => {
      return new Promise((resolve, reject) => {
        let view = window.App.views.mixView;
        let tracks = undefined;
        if (typeof view !== 'undefined') {
          view.mix.withInternationalTracks(() => {
            tracks = view.mix.tracks.models.map(model => model.attributes);

            resolve(tracks);
          });          
        }

        resolve(undefined);
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
      throw new error('Missing mix or tracks data.');

    const mixData = Buffer.from(transformMixData({ mix, tracks }));
    const fileName = `${mix.user}-${mix.name}.txt`;

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
  const response = await db.putItem({
    TableName: 'ArchiveDownloads',
    Item: {
      RequestId: { "S": download.requestId },
      MixUrl: { "S": download.url },
      File: { "S": data.fileName },
      Created: { "N": Date.now().toString() }
    }
  }).promise();

  if (response.err)
    throw response.err;
}