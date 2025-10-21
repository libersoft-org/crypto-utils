
/**
 * Contract address type for type safety across the codebase
 */
export type ContractAddress = string;

/**
 * GUID type for unique identifiers
 */
export type Guid = string;

export interface IAmount {
	amount: bigint;
	decimals?: number;
}

export interface IBalance {
	amount: bigint;
	currency: string;
	decimals?: number;
}

export interface IBalanceWithFiat {
	crypto: IBalance;
	fiat: IBalance | null;
	timestamp: Date;
}


export interface INativeCurrency {
	symbol?: string;
	iconURL?: string;
}

export interface INftMetadata {
	name?: string;
	description?: string;
	image?: string;
	external_url?: string;
	attributes?: Array<{
		trait_type: string;
		value: string | number;
	}>;
}

export type ICurrency = 
	| { type: 'native'; symbol: string; iconURL?: string; }
	| { type: 'token'; symbol: string; iconURL?: string; contract_address: string; decimals: number; }
	| { type: 'nft'; symbol: string; iconURL?: string; contract_address: string; tokenId: string; standard: 'ERC721' | 'ERC1155'; metadata?: INftMetadata; };

