import {checkRepository} from './repositoryChecks.js';
import {checkJavaScript, checkPython, listFiles} from './sourceChecks.js';

const sourceFiles = ['extension.js', 'prefs.js', ...listFiles('src'), ...listFiles('tests'), ...listFiles('tools')];
const javascriptFiles = sourceFiles.filter(file => file.endsWith('.js'));
const pythonFiles = sourceFiles.filter(file => file.endsWith('.py'));

checkJavaScript(javascriptFiles);
checkPython(pythonFiles);
checkRepository();

console.log(`Source, import boundaries, documentation links, release metadata and schemas passed (${javascriptFiles.length} JavaScript files).`);
