import { configure as configureProcess } from './util/process'
import { setDBFolder } from './Persisted'
export function configure(options) {
	if (options.processMap) {
		configureProcess(options.processMap)
	}
	if (options.dbFolder || options.cacheDbFolder) {
		setDBFolder(options)
	}
}
