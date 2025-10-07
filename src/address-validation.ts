/* Contract address validation utilities */

/**
 * Validates if a string is a valid Ethereum contract address
 * NOTE: This validation does NOT trim the input, as the actual usage code doesn't trim either
 * 
 * @param address - The address string to validate (exactly as it will be used)
 * @returns boolean - True if the address is valid
 */
export function isValidContractAddress(address: string | null | undefined): boolean {
	if (!address || typeof address !== 'string') {
		return false;
	}

	// Must start with 0x (no trimming - if there's whitespace, it should fail)
	if (!address.startsWith('0x')) {
		return false;
	}

	// Must be exactly 42 characters (0x + 40 hex chars)
	if (address.length !== 42) {
		return false;
	}

	// Must contain only valid hex characters after 0x
	const hexPart = address.slice(2);
	const hexRegex = /^[0-9a-fA-F]+$/;
	if (!hexRegex.test(hexPart)) {
		return false;
	}

	// Additional check: shouldn't be the zero address
	if (address.toLowerCase() === '0x0000000000000000000000000000000000000000') {
		return false;
	}

	return true;
}