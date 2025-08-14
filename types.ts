export interface IWallet {
	guid: string;
	type?: 'software' | 'trezor' | 'ledger';
	name: string;
	phrase?: string;
	address?: string;
	selected_address_index: number;
	addresses?: IAddress[];
	identifiers?: any; // For hardware wallets, this can include deviceId
}

export interface IAddress {
	address: string;
	name: string;
	path: string;
	index: number;
}

export interface IAddressBookItem {
	guid: string;
	name: string;
	address: string;
}
export interface IAddressBookValidationResult {
	isValid: boolean;
	error?: string;
}
export interface IAddressBookImportResult {
	success: boolean;
	error?: string;
	addedCount?: number;
}

export interface IBalance {
	amount: bigint;
	currency: string;
	decimals?: number;
}

export interface IDefaultNetwork {
	name: string;
	chainID: number;
	testnet: boolean;
	rpcURLs: string[];
	currency: {
		symbol: string;
		iconURL: string;
	};
	explorerURL: string;
	tokens?: IToken[];
}

export interface INetwork {
	guid?: string;
	name: string;
	chainID: number;
	explorerURL?: string;
	currency: ICurrency;
	rpcURLs?: string[];
	tokens?: IToken[];
	nfts?: INFT[];
	selectedRpcUrl?: string;
	testnet?: boolean;
}
export interface ICurrency {
	name?: string;
	symbol?: string;
	contract_address?: string;
	iconURL?: string;
}
export interface IRPCServer {
	url: string;
	latency: number | null;
	lastBlock: number | null;
	blockAge: number | null;
	isAlive: boolean;
	checking?: boolean;
}
export interface ITokenData {
	contract_address: string;
	iconURL?: string;
}
export interface IToken {
	guid: string;
	item: ITokenData;
}
export interface INFTData {
	contract_address: string;
	token_id: string;
	name?: string;
	description?: string;
	image?: string;
	animation_url?: string;
	external_url?: string;
	attributes?: Array<{
		trait_type: string;
		value: string | number;
	}>;
}
export interface INFT {
	guid: string;
	item: INFTData;
}

export interface INetworkStatus {
	color: 'red' | 'orange' | 'green';
	text: string;
}


export interface IPayment {
	address: string;
	amount: bigint;
	fee: bigint;
	symbol: string | null | undefined;
	contractAddress?: string; // For tokens - undefined for native currency
}

export interface FeeEstimate {
	low: string;
	average: string;
	high: string;
}

export interface TransactionTimeEstimate {
	low: string;
	average: string;
	high: string;
}
