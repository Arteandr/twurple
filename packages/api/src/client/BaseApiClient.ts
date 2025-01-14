import { Cacheable, CachedGetter } from '@d-fischer/cache-decorators';
import type { Logger } from '@d-fischer/logger';
import type { RateLimiter, RateLimiterStats } from '@d-fischer/rate-limiter';
import { ResponseBasedRateLimiter } from '@d-fischer/rate-limiter';
import {
	callTwitchApi,
	callTwitchApiRaw,
	handleTwitchApiResponseError,
	HttpStatusCodeError,
	transformTwitchApiResponse,
	type TwitchApiCallOptions
} from '@twurple/api-call';

import type { AccessTokenMaybeWithUserId, AuthProvider, TokenInfoData } from '@twurple/auth';
import { accessTokenIsExpired, InvalidTokenError, TokenInfo } from '@twurple/auth';
import { HellFreezesOverError, rtfm, type UserIdResolvable } from '@twurple/common';
import * as retry from 'retry';
import { HelixBitsApi } from '../api/helix/bits/HelixBitsApi';
import { HelixChannelApi } from '../api/helix/channel/HelixChannelApi';
import { HelixChannelPointsApi } from '../api/helix/channelPoints/HelixChannelPointsApi';
import { HelixCharityApi } from '../api/helix/charity/HelixCharityApi';
import { HelixChatApi } from '../api/helix/chat/HelixChatApi';
import { HelixClipApi } from '../api/helix/clip/HelixClipApi';
import { HelixEntitlementApi } from '../api/helix/entitlements/HelixEntitlementApi';
import { HelixEventSubApi } from '../api/helix/eventSub/HelixEventSubApi';
import { HelixExtensionsApi } from '../api/helix/extensions/HelixExtensionsApi';
import { HelixGameApi } from '../api/helix/game/HelixGameApi';
import { HelixGoalApi } from '../api/helix/goals/HelixGoalApi';
import { HelixHypeTrainApi } from '../api/helix/hypeTrain/HelixHypeTrainApi';
import { HelixModerationApi } from '../api/helix/moderation/HelixModerationApi';
import { HelixPollApi } from '../api/helix/poll/HelixPollApi';
import { HelixPredictionApi } from '../api/helix/prediction/HelixPredictionApi';
import { HelixRaidApi } from '../api/helix/raids/HelixRaidApi';
import { HelixScheduleApi } from '../api/helix/schedule/HelixScheduleApi';
import { HelixSearchApi } from '../api/helix/search/HelixSearchApi';
import { HelixStreamApi } from '../api/helix/stream/HelixStreamApi';
import { HelixSubscriptionApi } from '../api/helix/subscriptions/HelixSubscriptionApi';
import { HelixTeamApi } from '../api/helix/team/HelixTeamApi';
import { HelixUserApi } from '../api/helix/user/HelixUserApi';
import { HelixVideoApi } from '../api/helix/video/HelixVideoApi';
import { HelixWhisperApi } from '../api/helix/whisper/HelixWhisperApi';

import { type ApiConfig, type TwitchApiCallOptionsInternal } from './ApiClient';
import { type ContextApiCallOptions } from './ContextApiCallOptions';

/** @private */
@Cacheable
@rtfm('api', 'ApiClient')
export class BaseApiClient {
	protected readonly _config: ApiConfig;
	protected readonly _logger: Logger;
	protected readonly _rateLimiter: RateLimiter<TwitchApiCallOptionsInternal, Response>;

	/** @private */
	constructor(config: ApiConfig, logger: Logger, rateLimiter: RateLimiter<TwitchApiCallOptionsInternal, Response>) {
		this._config = config;
		this._logger = logger;
		this._rateLimiter = rateLimiter;
	}

	/**
	 * Requests scopes from the auth provider for the given user.
	 *
	 * @param user The user to request scopes for.
	 * @param scopes The scopes to request.
	 */
	async requestScopesForUser(user: UserIdResolvable, scopes: string[]): Promise<void> {
		await this._config.authProvider.getAccessTokenForUser(user, scopes);
	}

	/**
	 * Gets information about your access token.
	 */
	async getTokenInfo(): Promise<TokenInfo> {
		try {
			const data = await this.callApi<TokenInfoData>({ type: 'auth', url: 'validate' });
			return new TokenInfo(data);
		} catch (e) {
			if (e instanceof HttpStatusCodeError && e.statusCode === 401) {
				throw new InvalidTokenError({ cause: e });
			}
			throw e;
		}
	}

	/**
	 * Makes a call to the Twitch API using your access token.
	 *
	 * @param options The configuration of the call.
	 */
	async callApi<T = unknown>(options: ContextApiCallOptions): Promise<T> {
		const { authProvider } = this._config;
		const shouldAuth = options.auth ?? true;

		if (!shouldAuth) {
			return await callTwitchApi<T>(
				options,
				authProvider.clientId,
				undefined,
				undefined,
				this._config.fetchOptions
			);
		}

		let forceUser = false;

		if (options.forceType) {
			switch (options.forceType) {
				case 'app': {
					if (!authProvider.getAppAccessToken) {
						throw new Error(
							'Tried to make an API call that requires an app access token but your auth provider does not support that'
						);
					}
					const accessToken = await authProvider.getAppAccessToken();
					return await this._callApiUsingInitialToken(options, accessToken);
				}
				case 'user': {
					forceUser = true;
					break;
				}
				default: {
					throw new HellFreezesOverError(`Unknown forced token type: ${options.forceType as string}`);
				}
			}
		}

		if (options.scopes) {
			forceUser = true;
		}

		if (forceUser) {
			const contextUserId = options.canOverrideScopedUserContext
				? this._getUserIdFromRequestContext(options)
				: options.userId;

			if (!contextUserId) {
				throw new Error('Tried to make an API call with a scope but no context user ID');
			}

			const accessToken = await authProvider.getAccessTokenForUser(contextUserId, options.scopes);

			if (!accessToken) {
				throw new Error(
					`Tried to make an API call with a scope for user ID ${contextUserId} but no token was found`
				);
			}

			if (accessTokenIsExpired(accessToken) && authProvider.refreshAccessTokenForUser) {
				const newAccessToken = await authProvider.refreshAccessTokenForUser(contextUserId);
				return await this._callApiUsingInitialToken(options, newAccessToken);
			}

			return await this._callApiUsingInitialToken(options, accessToken);
		}

		const requestContextUserId = this._getUserIdFromRequestContext(options);
		const accessToken =
			requestContextUserId === null
				? await authProvider.getAnyAccessToken()
				: await authProvider.getAnyAccessToken(requestContextUserId ?? options.userId);

		if (accessTokenIsExpired(accessToken) && accessToken.userId && authProvider.refreshAccessTokenForUser) {
			const newAccessToken = await authProvider.refreshAccessTokenForUser(accessToken.userId);
			return await this._callApiUsingInitialToken(options, newAccessToken);
		}

		return await this._callApiUsingInitialToken<T>(options, accessToken);
	}

	/**
	 * The Helix bits API methods.
	 */
	@CachedGetter()
	get bits(): HelixBitsApi {
		return new HelixBitsApi(this);
	}

	/**
	 * The Helix channels API methods.
	 */
	@CachedGetter()
	get channels(): HelixChannelApi {
		return new HelixChannelApi(this);
	}

	/**
	 * The Helix channel points API methods.
	 */
	@CachedGetter()
	get channelPoints(): HelixChannelPointsApi {
		return new HelixChannelPointsApi(this);
	}

	/**
	 * The Helix charity API methods.
	 */
	@CachedGetter()
	get charity(): HelixCharityApi {
		return new HelixCharityApi(this);
	}

	/**
	 * The Helix chat API methods.
	 */
	@CachedGetter()
	get chat(): HelixChatApi {
		return new HelixChatApi(this);
	}

	/**
	 * The Helix clips API methods.
	 */
	@CachedGetter()
	get clips(): HelixClipApi {
		return new HelixClipApi(this);
	}

	/**
	 * The Helix entitlement API methods.
	 */
	@CachedGetter()
	get entitlements(): HelixEntitlementApi {
		return new HelixEntitlementApi(this);
	}

	/**
	 * The Helix EventSub API methods.
	 */
	@CachedGetter()
	get eventSub(): HelixEventSubApi {
		return new HelixEventSubApi(this);
	}

	/**
	 * The Helix extensions API methods.
	 */
	@CachedGetter()
	get extensions(): HelixExtensionsApi {
		return new HelixExtensionsApi(this);
	}

	/**
	 * The Helix game API methods.
	 */
	@CachedGetter()
	get games(): HelixGameApi {
		return new HelixGameApi(this);
	}

	/**
	 * The Helix Hype Train API methods.
	 */
	@CachedGetter()
	get hypeTrain(): HelixHypeTrainApi {
		return new HelixHypeTrainApi(this);
	}

	/**
	 * The Helix goal API methods.
	 */
	@CachedGetter()
	get goals(): HelixGoalApi {
		return new HelixGoalApi(this);
	}

	/**
	 * The Helix moderation API methods.
	 */
	@CachedGetter()
	get moderation(): HelixModerationApi {
		return new HelixModerationApi(this);
	}

	/**
	 * The Helix poll API methods.
	 */
	@CachedGetter()
	get polls(): HelixPollApi {
		return new HelixPollApi(this);
	}

	/**
	 * The Helix prediction API methods.
	 */
	@CachedGetter()
	get predictions(): HelixPredictionApi {
		return new HelixPredictionApi(this);
	}

	/**
	 * The Helix raid API methods.
	 */
	@CachedGetter()
	get raids(): HelixRaidApi {
		return new HelixRaidApi(this);
	}

	/**
	 * The Helix schedule API methods.
	 */
	@CachedGetter()
	get schedule(): HelixScheduleApi {
		return new HelixScheduleApi(this);
	}

	/**
	 * The Helix search API methods.
	 */
	@CachedGetter()
	get search(): HelixSearchApi {
		return new HelixSearchApi(this);
	}

	/**
	 * The Helix stream API methods.
	 */
	@CachedGetter()
	get streams(): HelixStreamApi {
		return new HelixStreamApi(this);
	}

	/**
	 * The Helix subscription API methods.
	 */
	@CachedGetter()
	get subscriptions(): HelixSubscriptionApi {
		return new HelixSubscriptionApi(this);
	}

	/**
	 * The Helix team API methods.
	 */
	@CachedGetter()
	get teams(): HelixTeamApi {
		return new HelixTeamApi(this);
	}

	/**
	 * The Helix user API methods.
	 */
	@CachedGetter()
	get users(): HelixUserApi {
		return new HelixUserApi(this);
	}

	/**
	 * The Helix video API methods.
	 */
	@CachedGetter()
	get videos(): HelixVideoApi {
		return new HelixVideoApi(this);
	}

	/**
	 * The API methods that deal with whispers.
	 */
	@CachedGetter()
	get whispers(): HelixWhisperApi {
		return new HelixWhisperApi(this);
	}

	/**
	 * Statistics on the rate limiter for the Helix API.
	 */
	get rateLimiterStats(): RateLimiterStats | null {
		if (this._rateLimiter instanceof ResponseBasedRateLimiter) {
			return this._rateLimiter.stats;
		}

		return null;
	}

	/** @private */
	get _authProvider(): AuthProvider {
		return this._config.authProvider;
	}

	// null means app access, undefined means none specified
	protected _getUserIdFromRequestContext(options: ContextApiCallOptions): string | null | undefined {
		return options.userId;
	}

	private async _callApiUsingInitialToken<T = unknown>(
		options: TwitchApiCallOptions,
		accessToken: AccessTokenMaybeWithUserId
	): Promise<T> {
		const { authProvider } = this._config;

		const authorizationType = authProvider.authorizationType;
		let response = await this._callApiInternal(
			options,
			authProvider.clientId,
			accessToken.accessToken,
			authorizationType
		);
		if (response.status === 401) {
			if (accessToken.userId) {
				if (authProvider.refreshAccessTokenForUser) {
					const token = await authProvider.refreshAccessTokenForUser(accessToken.userId);
					response = await this._callApiInternal(
						options,
						authProvider.clientId,
						token.accessToken,
						authorizationType
					);
				}
			} else {
				if (authProvider.getAppAccessToken) {
					const token = await authProvider.getAppAccessToken(true);
					response = await this._callApiInternal(
						options,
						authProvider.clientId,
						token.accessToken,
						authorizationType
					);
				}
			}
		}

		await handleTwitchApiResponseError(response, options);

		return await transformTwitchApiResponse<T>(response);
	}

	private async _callApiInternal(
		options: TwitchApiCallOptions,
		clientId?: string,
		accessToken?: string,
		authorizationType?: string
	) {
		const { fetchOptions } = this._config;
		const type = options.type ?? 'helix';
		this._logger.debug(`Calling ${type} API: ${options.method ?? 'GET'} ${options.url}`);
		this._logger.trace(`Query: ${JSON.stringify(options.query)}`);
		if (options.jsonBody) {
			this._logger.trace(`Request body: ${JSON.stringify(options.jsonBody)}`);
		}
		const op = retry.operation({
			retries: 3,
			minTimeout: 500,
			factor: 2
		});

		const result = await new Promise<Response>((resolve, reject) => {
			op.attempt(async () => {
				try {
					const response =
						type === 'helix'
							? await this._rateLimiter.request({
									options,
									clientId,
									accessToken,
									authorizationType,
									fetchOptions
							  })
							: await callTwitchApiRaw(options, clientId, accessToken, authorizationType, fetchOptions);

					if (!response.ok && response.status >= 500 && response.status < 600) {
						await handleTwitchApiResponseError(response, options);
					}
					resolve(response);
				} catch (e) {
					if (op.retry(e as Error)) {
						return;
					}
					reject(op.mainError());
				}
			});
		});

		this._logger.debug(`Called ${type} API: ${options.method ?? 'GET'} ${options.url} - result: ${result.status}`);

		return result;
	}
}
