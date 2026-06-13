import { Nord, NordUser } from "@n1xyz/nord-ts";
import { Connection } from "@solana/web3.js";
import { log } from "../utils/logger.js";

const MAINNET_CONFIG = {
	webServerUrl: "https://zo-mainnet.n1.xyz",
	app: "zoau54n5U24GHNKqyoziVaVxgsiQYnPMx33fKmLLCT5",
	rpcUrl: "https://api.mainnet-beta.solana.com",
};

export interface ZoClient {
	readonly nord: Nord;
	readonly user: NordUser;
	readonly accountId: number;
}

export async function createZoClient(privateKey: string): Promise<ZoClient> {
	log.info("Connecting to 01 Exchange (mainnet)...");

	const connection = new Connection(MAINNET_CONFIG.rpcUrl, "confirmed");

	const nord = await Nord.new({
		webServerUrl: MAINNET_CONFIG.webServerUrl,
		app: MAINNET_CONFIG.app,
		solanaConnection: connection,
	});

	// Pass private key as string directly (SDK handles conversion)
	const user = NordUser.fromPrivateKey(nord, privateKey);
	const pubkey = user.publicKey?.toString();
	log.info(`Wallet: ${pubkey}`);

	await user.refreshSession();
	await user.updateAccountId();
	await user.fetchInfo();

	const accountId = user.accountIds?.[0];
	if (accountId === undefined) {
		throw new Error(
			`No account found for ${pubkey}. Deposit funds on 01.xyz to create an account.`,
		);
	}

	log.info(`Connected. Account ID: ${accountId}`);

	return { nord, user, accountId };
}
