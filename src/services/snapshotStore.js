import {createUsageRecord, createUsageSection} from '../core/usage.js';
import {validateUsageRecord} from '../core/usageValidation.js';
import {buildPath, readJsonAsync, stateDirectory, writeJsonAsync} from './files.js';

export async function readProviderSnapshot(providerId, directory = stateDirectory()) {
    try {
        return validateUsageRecord(await readJsonAsync(buildPath(directory, `${providerId}.json`)), providerId);
    } catch {
        return null;
    }
}

export async function loadProviderSnapshot(providerId, directory = stateDirectory()) {
    const cached = await readProviderSnapshot(providerId, directory);
    if (cached) {
        for (const name of ['limits', 'history']) {
            if (['ready', 'partial', 'stale'].includes(cached[name].status)) {
                cached[name] = {
                    ...cached[name],
                    ...createUsageSection('stale', 'Showing saved usage while refreshing.'),
                    updatedAt: cached[name].updatedAt,
                };
            }
        }
    }
    return cached ?? createUsageRecord(providerId);
}

export async function saveProviderSnapshot(record, directory = stateDirectory()) {
    try {
        await writeJsonAsync(buildPath(directory, `${record.id}.json`), record);
        return true;
    } catch {
        // Persistence failures must not hide the current provider result.
        return false;
    }
}
