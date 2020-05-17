class Aggregator extends Persisted {
	static forValue(id, value, transitionRequest) {
		
	}
	static updated(event, by) {
		// don't do anything, we don't want these events to propagate through here, and we do indexing based on upstream queue
	}
}
