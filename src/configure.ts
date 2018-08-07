import { configure as configureProcess } from './util/process'
import { configure as configurePersisted } from './Persisted'
import { setRequestContextClass } from './RequestContext'
export function configure(options) {
	if (options.dbFolder || options.cacheDbFolder || options.doesInitialization !== undefined) {
		configurePersisted(options)
	}
	if (options.RequestContext) {
		setRequestContextClass(options.RequestContext)
	}
}
