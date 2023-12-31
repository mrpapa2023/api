import {Buffer} from 'node:buffer';
import {sample} from '@jonahsnider/util';
import {Injectable, type OnModuleInit} from '@nestjs/common';
import type {ShortenedUrl} from '@prisma/client';
import {ApproximateCountKind, Prisma} from '@prisma/client';
import convert from 'convert';
import type {Opaque} from 'type-fest';
import type {Logger} from '../logger/interfaces/logger.interface';
import {PrismaService} from '../prisma/prisma.service';
import {LoggerService} from '../logger/logger.service';
import {UniqueShortIdTimeoutException} from './exceptions/unique-short-id-timeout.exception';
import type {UrlStats} from './interfaces/url-stats.interface';
import type {VisitUrlData} from './interfaces/visit-url-data.interface';
import {UrlsConfigService} from './urls-config.service';

/** A short ID. */
export type Short = Opaque<string, 'Short'>;

/** A base64 encoded string. */
type Base64 = Opaque<string, 'Base64'>;

/** Maximum number of attempts to generate a unique ID. */
const MAX_SHORT_ID_GENERATION_ATTEMPTS = 10;

/** A regular expression for a domain name. */
const DOMAIN_NAME_REG_EXP = /(?:.+\.)?(.+\..+)$/i;

/** The number of milliseconds to cache private blocked hostnames from the database for. */
const BLOCKED_HOSTNAMES_CACHE_DURATION = convert(1, 'hour').to('ms');

@Injectable()
export class UrlsService implements OnModuleInit {
	private static encode(value: string): Base64 {
		return Buffer.from(value).toString('base64') as Base64;
	}

	private readonly blockedHostnames: Set<string>;

	private readonly logger: Logger;
	private blockedHostnamesLoadedFromDbAt = Number.NEGATIVE_INFINITY;

	constructor(private readonly config: UrlsConfigService, private readonly db: PrismaService, logger: LoggerService) {
		this.blockedHostnames = new Set(this.config.blockedHostnames);
		this.logger = logger.createLogger().withTag('app').withTag('urls');
	}

	async onModuleInit(): Promise<void> {
		await this.loadBlockedHostnamesFromDb();
	}

	/**
	 * Retrieve a shortened URL.
	 *
	 * @param id - The ID of the shortened URL to visit
	 *
	 * @returns The long URL and if it was blocked
	 */
	async retrieveUrl(id: Short): Promise<VisitUrlData | undefined> {
		const encodedId = UrlsService.encode(id);

		const shortenedUrl = await this.db.shortenedUrl.findUnique({where: {shortBase64: encodedId}, select: {url: true, blocked: true}});

		if (!shortenedUrl) {
			return undefined;
		}

		return {
			longUrl: shortenedUrl.url,
			blocked: shortenedUrl.blocked,
		};
	}

	/**
	 * Tracks a URL visit.
	 * @param id - The ID of the shortened URL
	 */
	async trackUrlVisit(id: Short): Promise<void> {
		const encodedId = UrlsService.encode(id);

		await this.db.$transaction([
			this.db.visit.create({data: {shortenedUrl: {connect: {shortBase64: encodedId}}}}),
			this.db.approximateCounts.update({where: {kind: ApproximateCountKind.VISITS}, data: {count: {increment: 1}}}),
		]);
	}

	/**
	 * Retrieve usage statistics for a shortened URL.
	 *
	 * @param id - The ID of the shortened URL
	 *
	 * @returns Shortened URL information and statistics, or `undefined` if it couldn't be found
	 */
	async statsForUrl(id: Short): Promise<UrlStats | undefined> {
		const encodedId = UrlsService.encode(id);

		const [visits, shortenedUrl] = await this.db.$transaction([
			this.db.visit.findMany({where: {shortenedUrlId: encodedId}, select: {timestamp: true}, orderBy: {timestamp: 'asc'}}),
			this.db.shortenedUrl.findUnique({where: {shortBase64: encodedId}, select: {url: true}}),
		]);

		if (shortenedUrl) {
			return {visits: visits.map(visit => visit.timestamp), url: shortenedUrl.url};
		}

		return undefined;
	}

	/**
	 * Shorten a long URL.
	 *
	 * @param url - The long URL to shorten
	 *
	 * @returns The ID of the shortened URL
	 */
	async shortenUrl(url: string): Promise<Short> {
		let attempts = 0;
		let created: ShortenedUrl | undefined;
		let id: Short;

		do {
			if (attempts++ > MAX_SHORT_ID_GENERATION_ATTEMPTS) {
				throw new UniqueShortIdTimeoutException(MAX_SHORT_ID_GENERATION_ATTEMPTS);
			}

			id = this.generateShortId();
			const shortBase64 = UrlsService.encode(id);

			try {
				// eslint-disable-next-line no-await-in-loop
				[created] = await this.db.$transaction([
					this.db.shortenedUrl.create({data: {url, shortBase64}}),
					this.db.approximateCounts.update({where: {kind: ApproximateCountKind.SHORTENED_URLS}, data: {count: {increment: 1}}}),
				]);
			} catch (error) {
				// https://www.prisma.io/docs/reference/api-reference/error-reference#p2002
				if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
					// Ignore the expected potential duplicate ID errors
				} else {
					throw error;
				}
			}
		} while (!created);

		return id;
	}

	async isHostnameBlocked(hostname: string): Promise<boolean> {
		await this.loadBlockedHostnamesFromDb();

		return (
			// Exact match
			this.blockedHostnames.has(hostname) ||
			// Domain name match
			this.blockedHostnames.has(hostname.replace(DOMAIN_NAME_REG_EXP, '$1'))
		);
	}

	/**
	 * Generate a short ID.
	 * Not guaranteed to be unique.
	 *
	 * @returns A short ID
	 */
	private generateShortId(): Short {
		let shortId = '' as Short;

		for (let i = 0; i < this.config.shortenedLength; i++) {
			// @ts-expect-error String concatenation forces string type
			shortId += sample(this.config.characters) as Short;
		}

		return shortId;
	}

	private async loadBlockedHostnamesFromDb(): Promise<void> {
		if (Date.now() - this.blockedHostnamesLoadedFromDbAt < BLOCKED_HOSTNAMES_CACHE_DURATION) {
			return;
		}

		const initialSize = this.blockedHostnames.size;

		this.logger.debug('Loading blocked hostnames from DB');
		const blockedHostnames = await this.db.blockedHostname.findMany({select: {hostname: true}});

		for (const blockedHostname of blockedHostnames) {
			this.blockedHostnames.add(blockedHostname.hostname);
		}

		const newSize = this.blockedHostnames.size;

		this.logger.info(`Loaded ${blockedHostnames.length} blocked hostnames from DB`);
		this.logger.info(`Blocked hostnames cache size: ${newSize} (added ${newSize - initialSize})`);

		this.blockedHostnamesLoadedFromDbAt = Date.now();
	}
}
