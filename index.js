"use strict";

const Botkit = require("botkit");
const puppeteer = require("puppeteer");
const request = require("request");
const url = require("url");
const querystring = require("querystring");
const { WebClient } = require('@slack/client');
const he = require('he');

// This configuration can gets overwritten when process.env.SLACK_MESSAGE_EVENTS is given.
const DEFAULT_SLACK_MESSAGE_EVENTS = "direct_message,direct_mention,mention";

if (!process.env.SLACK_BOT_TOKEN) {
  console.error("Error: Specify SLACK_BOT_TOKEN in environment values");
  process.exit(1);
}
if (!((process.env.REDASH_HOST && process.env.REDASH_API_KEY) || (process.env.REDASH_HOSTS_AND_API_KEYS))) {
  console.error("Error: Specify REDASH_HOST and REDASH_API_KEY in environment values");
  console.error("Or you can set multiple Re:dash configs by specifying like below");
  console.error("REDASH_HOSTS_AND_API_KEYS=\"http://redash1.example.com;TOKEN1,http://redash2.example.com;TOKEN2\"");
  process.exit(1);
}

const parseApiKeysPerHost = () => {
  if (process.env.REDASH_HOST) {
    if (process.env.REDASH_HOST_ALIAS) {
      return {[process.env.REDASH_HOST]: {"alias": process.env.REDASH_HOST_ALIAS, "key": process.env.REDASH_API_KEY}};
    } else {
      return {[process.env.REDASH_HOST]: {"alias": process.env.REDASH_HOST, "key": process.env.REDASH_API_KEY}};
    }
  } else {
    return process.env.REDASH_HOSTS_AND_API_KEYS.split(",").reduce((m, host_and_key) => {
      var [host, alias, key] = host_and_key.split(";");
      if (!key) {
        key = alias;
        alias = host;
      }
      m[host] = {"alias": alias, "key": key};
      return m;
    }, {});
  }
};

const queryToSearch = (query) => {
  const str = querystring.stringify(query);
  if(str.length === 0) return "";
  return `?${str}`;
};

const screenshot = async (embedUrl) => {
  let browser;
  try {
    browser = await puppeteer.launch({ timeout: 10000 });
    const page = await browser.newPage();
    await page.goto(embedUrl, { timeout: 10000 });
    await page.waitForSelector("div[ng-view]", { timeout: 10000 });
    const elem = await page.$("div[ng-view]");
    return await elem.screenshot();
  } finally {
    if (browser) await browser.close();
  }
}

const redashApiKeysPerHost = parseApiKeysPerHost();
const slackBotToken = process.env.SLACK_BOT_TOKEN;
const slackMessageEvents = process.env.SLACK_MESSAGE_EVENTS || DEFAULT_SLACK_MESSAGE_EVENTS;
const slack = new WebClient(slackBotToken);

const controller = Botkit.slackbot({
  debug: !!process.env.DEBUG
});

controller.spawn({
  token: slackBotToken
}).startRTM();

Object.keys(redashApiKeysPerHost).forEach((redashHost) => {
  const redashHostAlias = redashApiKeysPerHost[redashHost]["alias"];
  const redashApiKey    = redashApiKeysPerHost[redashHost]["key"];
  controller.hears(`${redashHost}/queries/([0-9]+)[^>]*`, slackMessageEvents, async (bot, message) => {
    const originalUrl = message.match[0];
    const queryId = message.match[1];
    const parsedUrl = url.parse(he.decode(originalUrl), true);

    if(parsedUrl.hash === null) {
      bot.reply(message, "Please specify visualization id by hash");
      return;
    }

    const visualizationId = parsedUrl.hash.substring(1);
    const search = queryToSearch(parsedUrl.query);
    const searchWithKey = queryToSearch(Object.assign({ api_key: redashApiKey }, parsedUrl.query));
    const queryUrl = `${redashHostAlias}/queries/${queryId}${search}#${visualizationId}`;
    const embedUrl = `${redashHostAlias}/embed/query/${queryId}/visualization/${visualizationId}${searchWithKey}`;

    bot.startTyping(message);
    bot.botkit.log(queryUrl);
    bot.botkit.log(embedUrl);

    let buff;
    try {
      buff = await screenshot(embedUrl);

      bot.botkit.log.debug(Object.keys(message));
      bot.botkit.log(message.user + ":" + message.type + ":" + message.channel + ":" + message.text);
    } catch(err) {
      const msg = `Something wrong happend in take a screen capture : ${err}`;
      bot.reply(message, msg);
      return bot.botkit.log.error(msg);
    }

    if(buff === null) return ;

    try {
      await slack.files.upload({
        channels: message.channel,
        filename: `query-${queryId}-visualization-${visualizationId}.png`,
        file: buff,
      });
      bot.botkit.log("ok");
    } catch(e) {
      const msg = `Something wrong happend in file upload : ${err}`;
      bot.reply(message, msg);
      bot.botkit.log.error(msg);
    }
  });
});
