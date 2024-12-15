import axios from "axios";
import * as cheerio from "cheerio";
import { Logger } from "./logger";
import { Redis } from "@upstash/redis";

const logger = new Logger("scraper");

const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL,
  token: process.env.UPSTASH_REDIS_REST_TOKEN,
});

const MAX_CACHE_SIZE = 1000000; // 1 mb
const CACHE_EXPIRATION_TIME = 7 * 60 * 60 * 24; // 7 days

export const urlPattern =
  /https?:\/\/(www\.)?[-a-zA-Z0-9@:%._\+~#=]{1,256}\.[a-zA-Z0-9()]{1,6}\b([-a-zA-Z0-9()@:%_\+.~#?&//=]*)/gi;

function cleanText(text: string): string {
  return text.replace(/\s+/g, " ").replace(/\n+/g, "").trim();
}

// export async function scrapeURL(url: string) {
//   const response = await axios.get(url);
//   const $ = cheerio.load(response.data);
//   const title = $("title").text();
//   console.log("response.data", response.data);
// }

export async function scrapeURL(url: string) {
  try {
    // check the cache first
    logger.info(`Scraping URL: ${url}`);
    const cached = await getCachedContent(url);

    if (cached) {
      logger.info(`using cached content for ${url}`);
      return cached;
    }
    logger.info(`cache miss - proceeding with fresh scrape for:${url}`);

    const response = await axios.get(url);
    const $ = cheerio.load(response.data);

    // remove script tags, style tags and comments
    $("script").remove();
    $("style").remove();
    $("noscript").remove();
    $("iframe").remove();
    $("img").remove();
    $("video").remove();
    $("audio").remove();
    $("form").remove();
    $("button").remove();

    // get useful info
    const title = $("title").text();
    const metaDescription = $('meta[name="description"]').attr("content") || "";
    const h1 = $("h1")
      .map((i, el) => $(el).text())
      .get()
      .join(" ");
    const h2 = $("h2")
      .map((i, el) => $(el).text())
      .get()
      .join(" ");

    // get text from elements
    const articleText = $("article")
      .map((i, el) => $(el).text())
      .get()
      .join(" ");
    const mainText = $("main")
      .map((i, el) => $(el).text())
      .get()
      .join(" ");

    const contentText = $('.content, #content, [class*="content"]')
      .map((i, el) => $(el).text())
      .get()
      .join(" ");

    // grab all paragraphs
    const paragraphText = $("p")
      .map((i, el) => $(el).text())
      .get()
      .join(" ");
    const listText = $("li")
      .map((i, el) => $(el).text())
      .get()
      .join(" ");

    // combine all content
    let combinedContent = [
      title,
      metaDescription,
      h1,
      h2,
      articleText,
      mainText,
      contentText,
      paragraphText,
      listText,
    ].join(" ");

    // clean and truncate the content
    combinedContent = cleanText(combinedContent).slice(0, 50000);

    // const finalResponse = {
    //   url:url,
    //   title: cleanText(title),
    //   headings: {
    //     h1: cleanText(h1),
    //     h2: cleanText(h2),
    //   },
    //   metaDescription: cleanText(metaDescription),
    //   content: combinedContent,
    //   error: null,
    // };

    const finalResponse = {
      url,
      title: cleanText(title),
      headings: {
        h1: cleanText(h1),
        h2: cleanText(h2),
      },
      metaDescription: cleanText(metaDescription),
      content: combinedContent,
      error: null,
      createdAt: Date.now(),
    };
    await cacheContent(url, finalResponse);

    return finalResponse;
  } catch (error) {
    console.error(`Error scraping ${url}:`, error);
    return {
      url,
      title: "",
      headings: { h1: "", h2: "" },
      metaDescriptions: "",
      content: "",
      error: "Failed to scrape url",
    };
  }
}

function isValidScrappedContent(data: ScrapedContent): data is ScrapedContent {
  return (
    typeof data === "object" &&
    data !== null &&
    typeof data.url === "string" &&
    typeof data.title === "string" &&
    typeof data.headings === "object" &&
    typeof data.metaDescription === "string" &&
    typeof data.content === "string" &&
    (typeof data.error === "string" || data.error === null) &&
    typeof data.createdAt === "number"
  );
}

// function to get cache key for a URL with sanitization
function getCacheKey(url: string): string {
  const sanitizedUrl = url.substring(0, 255);
  return `scraped:${sanitizedUrl}`;
}

export interface ScrapedContent {
  url: string;
  title: string;
  headings: {
    h1: string;
    h2: string;
  };
  metaDescription: string;
  content: string;
  error: string | null;
  createdAt: number;
}

async function cacheContent(
  url: string,
  content: ScrapedContent
): Promise<void> {
  try {
    const cacheKey = getCacheKey(url);
    content.createdAt = Date.now();
    console.log("content", content);
    if (!isValidScrappedContent(content)) {
      logger.error(`Invalid content for ${url}`);
      return;
    }

    const serialized = JSON.stringify(content); // format content into string

    // if too big, dont cach
    if (serialized.length > MAX_CACHE_SIZE) {
      logger.warn(`Content for ${url} is too large to cache`);
      return;
    }

    await redis.set(cacheKey, serialized, { ex: CACHE_EXPIRATION_TIME });
    logger.info(`Cached content for ${url}`);
  } catch (error) {
    logger.error(`Error caching content for ${url}: ${error}`);
  }
}

// get cached content with error handling
async function getCachedContent(url: string): Promise<ScrapedContent | null> {
  try {
    const key = getCacheKey(url);
    logger.info(`checking cache for key: ${key}`);

    const cached = await redis.get(key);

    if (!cached) {
      logger.info(`Cache miss - no cached content for:  ${url}`);
      return null;
    }

    logger.info(`Cache hit - found content for: ${url}`);

    let parsed: any;

    if (typeof cached === "string") {
      try {
        parsed = JSON.parse(cached);
      } catch (parseError) {
        logger.error(`Error parsing cached data for ${url}: ${parseError}`);
        await redis.del(key); // --> delete item in the cache
        return null;
      }
    } else {
      parsed = cached;
    }

    if (isValidScrappedContent(parsed as ScrapedContent)) {
      const age = Date.now() - (parsed as ScrapedContent).createdAt;
      logger.info(
        `Cache hit for ${url} with age ${Math.round(age / 1000 / 60)} minutes`
      );
      return parsed as ScrapedContent;
    }

    logger.warn(`Invalid cached data for ${url}`);
    await redis.del(key);
    return null;
  } catch (error) {
    logger.error(`Error getting cached scraped content for ${url}: ${error}`);
    return null;
  }
}
// function to get cached content with error handling

//     const finalResponse = {
//       url,
//       title: cleanText(title),
//       headings: {
//         h1: cleanText(h1),
//         h2: cleanText(h2),
//       },
//       metaDescription: cleanText(metaDescription),
//       content: combinedText,
//       error: null,
//       createdAt: Date.now(),
//     };

//     await cacheContent(url, finalResponse);

//     return finalResponse;
//   } catch (error) {
//     console.log(
//       "error scraping url",
//       url,
//       error instanceof Error ? error.message : "Unknown error"
//     );
//     const browser = await puppeteer.launch({ headless: false });
//     try {
//       const page = await browser.newPage();
//       await page.setUserAgent(
//         "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/88.0.4324.96 Safari/537.36"
//       );

//       await page.setViewport({ width: 1080, height: 1024 });

//       await page.goto(url, { waitUntil: "networkidle2" });

//       await page.waitForSelector("body", { timeout: 90000 });
//       const headings = await page.$$eval("h1", els =>
//         els.map(el => el.innerText.trim())
//       );
//       console.log("Encabezados encontrados:", headings);

//       const content = await page.evaluate(() => {
//         const remove = [
//           "script",
//           "style",
//           "noscript",
//           "iframe",
//           "img",
//           "video",
//           "audio",
//           "form",
//           "button",
//         ];

//         remove.forEach(selector => {
//           document.querySelectorAll(selector).forEach(el => el.remove());
//         });

//         const title = document.title;
//         const h1 = Array.from(document.querySelectorAll("h1"))
//           .map(el => el.textContent)
//           .join(" ");
//         const h2 = Array.from(document.querySelectorAll("h2"))
//           .map(el => el.textContent)
//           .join(" ");
//         const h3 = Array.from(document.querySelectorAll("h3"))
//           .map(el => el.textContent)
//           .join(" ");
//         const metaDescription = Array.from(
//           document.querySelectorAll('meta[name="description"]')
//         )
//           .map(el => el.getAttribute("content"))
//           .join(" ");
//         const article = Array.from(document.querySelectorAll("article"))
//           .map(el => el.textContent)
//           .join(" ");
//         const p = Array.from(document.querySelectorAll("p"))
//           .map(el => el.textContent)
//           .join(" ");
//         const li = Array.from(document.querySelectorAll("li"))
//           .map(el => el.textContent)
//           .join(" ");

//         return {
//           title,
//           metaDescription,
//           headings: {
//             h1,
//             h2,
//             h3,
//           },
//           content: [article, p, li].join(" "),
//         };
//       });

//       await browser.close();
//       console.log("content PUPPETEER", content);
//       return {
//         url,
//         title: content.title,
//         headings: content.headings,
//         metaDescription: content.metaDescription,
//         content: content.content,
//         error: null,
//         createdAt: Date.now(),
//       };
//     } catch (error) {
//       console.log("error", error);
//     }

//     return {
//       url,
//       title: null,
//       headings: null,
//       metaDescription: null,
//       content: null,
//       error: error instanceof Error ? error.message : "Unknown error",
//       createdAt: Date.now(),
//     };
//   }
// }
