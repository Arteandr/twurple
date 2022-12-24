import type { AuthProvider } from '@twurple/auth';
import { getValidTokenFromProviderForIntent } from '@twurple/auth';
import type { Options as BaseOptions } from 'tmi.js';
import { Client as BaseClient } from 'tmi.js';

/**
 * The tmi.js options, with the auth provider replacing the identity option.
 *
 * @inheritDoc
 */
export interface Options extends Omit<BaseOptions, 'identity'> {
	/**
	 * An authentication provider that supplies tokens to the client.
	 *
	 * For more information, see the {@link AuthProvider} documentation.
	 */
	authProvider: AuthProvider;
}

/**
 * An extension of the tmi.js client which extends it with {@link AuthProvider} integration.
 */
export class DecoratedClient extends BaseClient {
	/**
	 * Creates a new tmi.js client which utilizes the given {@link AuthProvider} instance.
	 *
	 * @param opts The tmi.js options, with the auth provider replacing the identity option.
	 */
	constructor(opts: Options) {
		const { authProvider, ...tmiOpts } = opts;
		super({
			...tmiOpts,
			identity: {
				// need this because we can't get a username dynamically, but need something to not default to justinfan
				username: 'dummy',
				password: async () => {
					const { accessToken } = await getValidTokenFromProviderForIntent(authProvider, 'chat', [
						'chat:read',
						'chat:edit'
					]);
					return accessToken.accessToken;
				}
			}
		});
	}
}

export const Client = DecoratedClient as typeof DecoratedClient & ((opts: Options) => DecoratedClient);
// eslint-disable-next-line @typescript-eslint/no-redeclare
export type Client = DecoratedClient;
