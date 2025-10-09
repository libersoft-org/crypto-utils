/* Top-level module to manage loading and refreshing of all info and balance data */

import { get } from 'svelte/store';
import { selectedNetwork } from './network';
import { selectedAddress } from './wallet';
import { provider } from './provider';
import { refreshBalance, nativeBalance } from './native';
import { refreshTokenBalance, loadAllTokenInfos, getTokensWithContracts, tokenBalances } from './tokens';
import { loadNFTsData, nftConfs } from './nfts';
import { balanceUpdateSync, fiat, getExchangeRates, updateAllFiats } from './fiat';

// Refresh interval in seconds
const REFRESH_INTERVAL = 300000;

// Single timer for all refreshes
let refreshTimer: ReturnType<typeof setTimeout> | null = null;
let refreshPromise: Promise<void> | null = null;
let isRefreshEnabled = false;

fiat.subscribe(currency => updateAllFiats());




// Refresh all token balances
async function refreshAllTokenBalances() {
	const tokensWithContracts = getTokensWithContracts();
	
	if (tokensWithContracts.length === 0) return;
	
	console.log(`Refreshing balances for ${tokensWithContracts.length} tokens`);
	
	// Refresh all token balances in parallel
	await Promise.all(
		tokensWithContracts.map(token => 
			token.contract_address ? refreshTokenBalance(token.contract_address) : Promise.resolve()
		)
	);
}

// Main refresh function - refreshes all balances
export async function refresh(): Promise<void> {
	// Prevent overlapping refreshes
	if (refreshPromise) {
		return refreshPromise;
	}

	const net = get(selectedNetwork);
	const addr = get(selectedAddress);
	const prov = get(provider);

	if (!net || !addr || !prov) {
		console.log('Cannot refresh: network, address, or provider not available');
		return;
	}

	console.log('Starting comprehensive refresh');

	refreshPromise = (async () => {
		try {
			// Load token infos first (needed for balance display)
			await loadAllTokenInfos();
			
			// Refresh all data in parallel
			await Promise.all([
				// Native currency balance
				(async () => {
					try {
						await refreshBalance();
					} finally {
					}
				})(),
				// Token balances
				refreshAllTokenBalances(),
				// NFT data
				loadNFTsData(get(nftConfs))
			]);

			// Update fiat conversions for all balances
			await updateAllFiats();

			// Schedule next refresh
			if (isRefreshEnabled) {
				refreshTimer = setTimeout(refresh, REFRESH_INTERVAL * 1000);
			}

		} catch (error) {
			console.error('Error during refresh:', error);
			// Schedule retry on error
			if (isRefreshEnabled) {
				refreshTimer = setTimeout(refresh, REFRESH_INTERVAL * 1000);
			}
		}
	})();

	await refreshPromise;
	refreshPromise = null;
}

// Reset all data (e.g., when switching wallets/networks)
export function reset(): void {
	console.log('Resetting all balance and info data');
	
	if (refreshTimer) {
		clearTimeout(refreshTimer);
		refreshTimer = null;
	}
	refreshPromise = null;
}

// Enable/disable automatic refresh
export function setRefreshEnabled(enabled: boolean): void {
	console.log('Setting refresh enabled:', enabled);
	isRefreshEnabled = enabled;
	
	if (enabled) {
		refresh();
	} else {
		if (refreshTimer) {
			clearTimeout(refreshTimer);
			refreshTimer = null;
		}
	}
}

// Initialize refresh system (call on app start)
export function initializeRefreshSystem(): () => void {
	//console.log('Initializing refresh system');
	
	// Watch for network/address changes and reset/refresh
	let currentNetwork = get(selectedNetwork);
	let currentAddress = get(selectedAddress);
	
	const unsubscribeNetwork = selectedNetwork.subscribe(async (network) => {
		if (network !== currentNetwork) {
			console.log('Network changed, resetting and refreshing');
			currentNetwork = network;
			reset();
			if (network && get(selectedAddress) && get(provider)) {
				await refresh();
			}
		}
	});

	const unsubscribeAddress = selectedAddress.subscribe(async (address) => {
		if (address !== currentAddress) {
			console.log('Address changed, resetting and refreshing');
			currentAddress = address;
			reset();
			if (address && get(selectedNetwork) && get(provider)) {
				await refresh();
			}
		}
	});

	// Start refresh system
	setRefreshEnabled(true);

	// Return cleanup function
	return () => {
		console.log('Cleaning up refresh system');
		setRefreshEnabled(false);
		unsubscribeNetwork();
		unsubscribeAddress();
	};
}