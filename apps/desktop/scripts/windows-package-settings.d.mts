/**
 * Validate file-owned Windows pack and cache worker limits before packaging starts.
 * @param environment Windows packaging settings loaded from .env.windows.
 * @returns Pack workers default to one and cache workers to four; invalid values throw.
 */
export function resolveWindowsPackageSettings(environment: NodeJS.ProcessEnv): { packConcurrency: number, signatureCacheConcurrency: number }
