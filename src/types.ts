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
	decimals?: number | undefined;
}

export interface IBalance {
	amount: bigint;
	currency: string;
	decimals?: number | undefined;
}

export interface IBalanceWithFiat {
	crypto: IBalance;
	fiat: IBalance | null;
	timestamp: Date;
}

export interface ICurrency {
	name?: string;
	symbol?: string;
	contract_address?: string;
	iconURL?: string | undefined;
}
