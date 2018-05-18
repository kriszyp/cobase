/* A HasUpdateProgress instance can be an entity, an event, a context/session, or a index class*/
export interface HasUpdateProgress {
	updatesInProgress: Map<Function, Promise<any>>
}
export function whenClassIsReady(Source, context: HasUpdateProgress): Promise<any> {
	return context.updatesInProgress && context.updatesInProgress.get(Source)
}
export function mergeProgress(target: HasUpdateProgress, source: HasUpdateProgress) {
	if (source.updatesInProgress) {
		for (const [Source, promise] of source.updatesInProgress) {
			registerProcessing(target, Source, promise)
		}
	}
}
export function registerProcessing(target: HasUpdateProgress, Source: Function, promise: Promise<HasUpdateProgress>) {
	if (!target.updatesInProgress) {
		target.updatesInProgress = new Map()
	}
	target.updatesInProgress.set(Source, promise = promise.then(newProgress => {
		if (target.updatesInProgress.get(Source) == promise) {
			target.updatesInProgress.delete(Source)
		}
		if (newProgress) {
			mergeProgress(target, newProgress)
		}
	}))
}
