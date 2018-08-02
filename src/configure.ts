import { configure as configureProcess } from './util/process'
import { setDBFolder } from './Persisted'
import { setRequestContextClass } from './RequestContext'
export function configure(options) {
	if (options.processMap) {
		configureProcess(options.processMap)
	}
	if (options.dbFolder || options.cacheDbFolder) {
		setDBFolder(options)
	}
	if (options.RequestContext) {
		setRequestContextClass(options.RequestContext)
	}
}
