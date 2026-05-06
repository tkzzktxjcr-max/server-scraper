import { Page } from "puppeteer-core";
import { BaseScraper, ScraperFilters, JobLogger, SearchResultItem, ScrapeResult } from "./base.js";
import { InterceptedResponse } from "../browser/manager.js";
import { RawListing } from "../utils/validation.js";
import { cleanString, cleanNumber, cleanInt, cleanEnergyRating, cleanPhotos, normalizePropertyType } from "../utils/validation.js";
import { PropertyData } from "../appwrite/client.js";
import { logger } from "../utils/logger.js";