import {createUsageRecord, createUsageSection} from '../core/usage.js';
import {validateUsageRecord} from '../core/usageValidation.js';
import {buildPath, readJson, stateDirectory, writeJson} from './files.js';

export function readProviderSnapshot(providerId, directory = stateDirectory()) {
    try {
        return validateUsageRecord(readJson(buildPath(directory, `${providerId}.json`)), providerId);
    } catch {
        return null;
    }
}

export function loadProviderSnapshot(providerId, directory = stateDirectory()) {
    const cached = readProviderSnapshot(providerId, directory);
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

export function saveProviderSnapshot(record, directory = stateDirectory()) {
    try {
        writeJson(buildPath(directory, `${record.id}.json`), record);
        return true;
    } catch {
        // Persistence failures must not hide the current provider result.
        return false;
    }
}
