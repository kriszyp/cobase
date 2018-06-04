/* A HasUpdateProgress instance can be an entity, an event, a context/session, or a index class*/
export interface HasUpdateProgress {
	updatesInProgress: Map<Function, Promise<any>>
}
export function whenClassIsReady(Source, context: HasUpdateProgress): Promise<any> {
	let whenReady = context.updatesInProgress && context.updatesInProgress.get(Source)
	if (whenReady && !whenReady.resultRegistered) {
		context.updatesInProgress.set(Source, whenReady = whenReady.then(newProgress => {
			if (context.updatesInProgress.get(Source) == whenReady) {
				context.updatesInProgress.delete(Source)
			}
			if (newProgress) {
				mergeProgress(context, newProgress)
			}
		}))
		whenReady.resultRegistered = true
	}
	return whenReady
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
	target.updatesInProgress.set(Source, promise)
}
