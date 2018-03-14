<img src="./assets/alkali-logo.svg?sanitize=true" alt="Alkali" width="100" align="right" />
Cobase is a composable layered system of JavaScript-defined, cached, persisted data transform functions and aggregations for building fast, efficient JavaScript-mapped relational data storage. Cobase is a reactive cache using Alkali's reactive API for entities. Cobase uses four basic data functional/processing constructs to build scalable relational data caches that can be used to query/access data efficiently to scale:
* Join
* Transform
* Index
* Reduce
<a href="https://dev.doctorevidence.com/"><img src="./assets/powers-dre.png" width="203" align="right" /></a>
From these constructs we can build data structures that can aggregate and index data from multiples tables and be queried in fast, scalable O(log n) time/space.

## Getting Started
First, install:
```
npm install cobase
```
And then we can begin creating basic persisted data structures. A basic table or data store can be constructed by simply creating a class that extends `Persisted` and calling `register` on it:
```
class Project extends Persisted {

}
Project.register()
```
And then we can begin adding data to it.
```
let newProject = Project.add({ name: 'Learn cobase', description: '...' })
```

The most common API for interacting with your persisted class instances, is to to get an instance for a given id/key, and then we can change it, or retrieve its value:

```
Project.for(1).valueOf()
```

We can then build various layers of transform that use this as our data source. We could also define our base data source from an external data source (SQL database, S3 storage, etc.), and much of Cobase is optimized around this type of architecture, but here we are using our own internal storage for the sake of examples.

## Composing Layers
### Transform
The first two compositional functions are available by defining a caching store, by extending `Cached`. This directly maps and transforms a source data store to the transformed and cached data. For example, if we wanted to select some properties from data source and cache them, we could do:
```
import { Cached } from 'cobase'
class ProjectSummary extends Cached.from(Project) {
	transform(project) {
		// transforms projects from the source data
		return { // just keep the name
			name: project.name
		}
	}
}
ProjectSummary.register({ version: 1 }) // we can assign a version to indicate changes in the transform
```
The resulting data store will lazily compute and cache these transformed summary objects, providing nearly instantaneous access on repeated accesses.

### Join
The compositional function is a join. The `Cached` base class can be create with more than one data source. We can provide multiple data sources, which are then combined by id, and passed into the `transform` function.
```
import { Cached } from 'cobase'
class ProjectSummary extends Cached.from(Project, ExtraProjectInfo) {
	transform(project, extraProjectInfo) {
		// transforms projects from the source data
		return { // just keep the name
			name: project.name,
			extraInfo: extraProjectInfo
		}
	}
}
```
Generally, a join is only interesting when it is combined with an index/map function that can index by a foreign key to relate two different data sources.

### Index
The third function is an indexing function, that allows one key-valued data source to be mapped to a different set of key-values. And index is created by extending `Indexed` class, and defining a `static` `indexBy` method (make sure you define it as a `static`!) Imagine we have another store that held a table of tasks, that each had a `projectId` that referenced a project that it belonged to. We can index the tasks store by project id:
```
import { Indexed } from 'cobase'
class TasksByProject extends Indexed({ Source: Task }) {
	static indexBy(task) { // make sure you define
		return {
			key: task.ProjectId,
			value: task
		}
	}
}
```
We now have created an index by the project id. We can join this to the project store to create relationally connected transformed store of cached data:
```
class ProjectWithTasks extends Cached.from(Project, TasksByProject) {
	transform(project, tasks) {
		return {
			name: project.name,
			tasks
		}
	}
}
```
This is a fully reactive cache; any changes to a project, or tasks will automatically update through the layers of the index and caches such `ProjectWithTasks` will be up-to-date.

### Reduce
This function provides efficient aggregation of indices, merging multiple values per index key with binary reduction. The `Reduced` class uses an `Indexed` class as a source, and aggregates the values of an index entry
in `O(log n)` time. The `Reduced` class should define a source index, and a `reduceBy(a, b)` method that takes two input values and reduces them to one that it returns. The `Reduced` class extends the `Cached` class and can optionally include a `transform` method to transform the total reduced value.

For example, if we wanted to compute the total estimated time of the tasks in project, this could become very expensive to recompute if there are large number of tasks in a project (`O(n)` after any update). However, a `Reduced` class can maintain this sum with incremental updates in `O(log n)` time.
```
class ProjectTotalHours extends Reduced.from(TasksByProject) {
	reduceBy(taskA, taskB) {
		return { // the returned value should be of the same type as the inputs
			hours: taskA.hours + taskB.hours
		}
	}
	transform(total) {
		return total.hours
	}
}
ProjectTotalHours.for(projectId).valueOf() -> get the total hours of the tasks for a project
```
Note that the `reduceBy` function is slightly different than a JavaScript `reduce` function in that both the inputs may be the output from previous `reduceBy` calls.

### Relation
Not yet implemented.
The Relation class defines a relation between two entities, effectively using the Join function to conveniently take two related tables and produce two tables that have their referenced data included.
```
const { From: TaskWithProject, To: ProjectWithTasks } = Relation({
	From: Task,
	To: Project,
	joinOn(task) {
		return task.projectId
	}
})
```

