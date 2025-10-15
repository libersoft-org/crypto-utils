import { derived } from 'svelte/store';
import type { ICurrency } from './types';
import { selectedNetwork } from './network';
import { tokenConfs, tokenInfos } from './tokens';

/**
 * Store for available currencies (native + tokens) for the selected network
 * Combines native currency with configured tokens that have loaded info
 */
export const currencies = derived([selectedNetwork, tokenConfs, tokenInfos], ([$selectedNetwork, $tokenConfs, $tokenInfos]) => {
	const currencyList: ICurrency[] = [];
	
	// Add native currency
	if ($selectedNetwork?.currency?.symbol) {
		currencyList.push({
			symbol: $selectedNetwork.currency.symbol,
			iconURL: $selectedNetwork.currency.iconURL,
		});
	}
	
	// Add tokens
	$tokenConfs?.forEach(token => {
		if (token.contract_address) {
			const tokenInfo = $tokenInfos.get(token.contract_address);
			const symbol = tokenInfo?.symbol || token.contract_address.slice(0, 8) + '...';
			currencyList.push({
				symbol: symbol,
				iconURL: token.iconURL,
				contract_address: token.contract_address,
			});
		}
	});

	return currencyList;
});