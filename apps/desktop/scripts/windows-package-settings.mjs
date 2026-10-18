/** Resolve file-owned Windows pack concurrency and signature-cache concurrency before packaging starts. */

/**
 * Validate tuning without accessing signing hardware.
 * @param {NodeJS.ProcessEnv} environment File-owned Windows packaging settings.
 * @returns {{packConcurrency: number, signatureCacheConcurrency: number}} Pack workers default to one; cache workers default to four.
 */
export function resolveWindowsPackageSettings(environment) {
  const pack = environment.DSH_DESKTOP_WINDOWS_PACK_CONCURRENCY ?? '1'
  if (!/^[1-9]\d*$/u.test(pack) || !Number.isSafeInteger(Number(pack))) {
    throw new Error('desktop package: DSH_DESKTOP_WINDOWS_PACK_CONCURRENCY must be a positive integer')
  }
  const value = environment.DSH_DESKTOP_WINDOWS_SIGNATURE_CACHE_CONCURRENCY ?? '4'
  if (!/^[1-8]$/u.test(value)) {
    throw new Error('desktop package: DSH_DESKTOP_WINDOWS_SIGNATURE_CACHE_CONCURRENCY must be an integer from 1 to 8')
  }
  return { packConcurrency: Number(pack), signatureCacheConcurrency: Number(value) }
}
