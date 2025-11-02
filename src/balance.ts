import { formatUnits } from 'ethers';
import type { IBalance } from './types';


export function formatBalance(balance: IBalance, roundToDecimals: number = -1, showCurrency: boolean = true): string | undefined {
	if (balance.amount === undefined || balance.amount === null) return undefined;
	let formatedAmount = formatUnits(balance.amount, balance.decimals !== undefined ? balance.decimals : 18);
	const decimals = balance.decimals !== undefined && balance.decimals !== null ? balance.decimals : 18;
	roundToDecimals = roundToDecimals > -1 ? roundToDecimals : decimals;
	// TODO: Intl.NumberFormat supports maximumFractionDigits only up to 20, so we need to handle larger fraction numbers differently
	//console.log('Formatting balance:', formatedAmount, 'with', roundToDecimals, 'decimals');
	return Intl.NumberFormat(undefined, {
		minimumFractionDigits: 0,
		maximumFractionDigits: roundToDecimals
	}).format(Number(formatedAmount)) + (showCurrency ? ' ' + balance.currency : '');
}


// Helpers to split formatted balance into value and symbol parts
export function getBalanceParts(b: IBalance, fractionDigits?: number): { value: string; symbol: string } {
	try {
		const formattedRaw = fractionDigits !== undefined ? formatBalance(b, fractionDigits) : formatBalance(b);
		const formatted = (formattedRaw ?? '').toString();
		const lastSpace = formatted.lastIndexOf(' ');
		if (lastSpace > 0) {
			return { value: formatted.slice(0, lastSpace), symbol: formatted.slice(lastSpace + 1) };
		}
		return { value: formatted, symbol: (b?.currency ?? '') as string };
	} catch (e) {
		return { value: '', symbol: (b?.currency ?? '') as string };
	}
}


