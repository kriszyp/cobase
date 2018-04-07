<img src="./assets/alkali-logo.svg?sanitize=true" alt="Alkali" width="100" align="right" />
Cobase is a composable layered system of JavaScript-defined, cached, persisted data transform functions and aggregations for building fast, efficient JavaScript-mapped relational data storage. Cobase is a reactive cache using Alkali's reactive API for entities. Cobase uses four basic data functional/processing constructs to build scalable relational data caches that can be used to query/access data efficiently to scale:

* Join
* Transform
* Index
* Reduce

<a href="https://dev.doctorevidence.com/"><img src="./assets/powers-dre.png" width="203" align="right" /></a>
From these constructs we can build data structures that can aggregate and index data from multiples tables and be queried in fast, scalable O(log n) time/space.

There are several key goals and philosophies that have shaped cobase:
* REST-oriented programming architecture that composes data stores by caching layering stores with a uniform interface, ideal for using as a caching/transformation middle tier to put in front of a simple backend storage.
* NoSQL/Document-based DB-functionality with relational capability.
* Scalable, performant data querying is acheived by ensuring data has been properly indexed to quickly satisfy queries, and data indexing and transformation, with full JS functionality, as the central focus of the API design.
* Defaulting to in-process data store access (via LevelDB) for extremely efficient/fast access to indexed/transformed data.

## Getting Started
First, install:
```
npm install cobase
```
And then we can begin creating basic persisted data structures. A basic table or data store can be constructed by simply creating a class that extends `Persisted` and calling `register` on it:
```
import { Persisted } from 'cobase'
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
Project.for(1).valueOf() -> return project with id of 1
// or shorthand:
Project.get(1)
```

Generally stores will return asynchronously, returning a promise to the data requested.

We can then build various layers of transform that use this as our data source. We could also define our base data source from an external data source (SQL database, S3 storage, etc.), and much of Cobase is optimized around this type of architecture, but here we are using our own internal storage for the sake of examples.

## Composing Layers
### Transform
The first two compositional functions are available by defining a transforming and caching store, by extending `Cached`. This directly maps and transforms a source data store to the transformed and cached data. For example, if we wanted to select some properties from data source and cache them, we could do:
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
The resulting data store will lazily compute and cache these transformed summary objects, providing fast access on repeated accesses.

When defining a transform/cached entry, you should specify a version number in the `register` method that should be incremented whenever the transform is changed so that the table can be recomputed when it changes.

### Join
The compositional aggregation functionality is a join, which is acheived by simply providing multiple data sources to the  `Cached` base class. We can provide multiple data sources, which are then combined by id, and passed into the `transform` function.
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
This allows you to compose a new table of data that is joined from two other tables. This can be used for a variety of situations, although generally, a join is most useful when it is combined with an index/map function that can index by a foreign key to relate two different data sources.

### Index
The third function is an indexing function, that allows one key-valued data source to be mapped to a generated different set of key-values, by different keys. And index is created by extending `Indexed` class, and defining a `static` `indexBy` method (make sure you define it as a `static`!) Imagine we have another store that held a table of tasks, that each had a `projectId` that referenced a project that it belonged to. We can index the tasks store by project id:
```
import { Indexed } from 'cobase'
class TasksByProject extends Indexed({ Source: Task }) {
	static indexBy(task) { // make sure you define this with static
		return task.projectId // this will index tasks by project ids
	}
}
```
We now have created an index of tasks by the project id. We can join this to the project store to create relationally connected transformed store of cached data:
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
This is also fully reactive index; any changes to a project, or tasks will automatically update through the layers of the index and caches such `ProjectWithTasks` will be up-to-date.

When `indexBy` simple returns a key, the index will default to generate a store where values comes from the source values. That means that in this case, the indexed key will be the project id, and the value will be the array of tasks with that project id. However, `indexBy` supports a number of different ways to specify keys *and* values. First, `indexBy` can return multiple keys (rather than just a single key in the example above). This can be done by simply returning an array of keys.

We can also specify the values in the indexed table as well. Again, if no value is specified, it will default to the input data source (and will be stored as a reference for efficiency). However, we can specify both the key and value by simply returning an object with `key` and `value` properties. And furthermore, if we want multiple keys and values generated, we can return an array of objects with `key`/`value` properties.

For example:
```
static indexBy(task) {
	return task.projectIds.map(projectId => ({ // if this was a many to many relationship, with multiple project ids
		key: projectId, // index using the project id as the key
		value: { // if we wanted our index to just store the name and ids of the tasks
			id: task.id,
			name: task.name
		}
	}))
}
```
And if we accessed a `ProjectWithTasks` by a project id, this would return a promise to an array of of the task id and name of tasks referencing this project:
```
ProjectWithTasks.get(projectId)
```

### Reduce
This function provides efficient aggregation of indices, merging multiple values per index key with a reduction operator. Without a reduce function, an index just returns an array of the entries for a given index key, but a reduce function provides a custom function to aggregate values under an index key. The `Reduced` class uses an `Index` class as a source, and aggregates the values of an index entry in `O(log n)` time using a tree/graph reduction algorithm. The `Reduced` class should define a source index, and a `reduceBy(a, b)` method that takes two input values and reduces them to one that it returns. The `Reduced` class extends the `Cached` class and can optionally include a `transform` method to transform the total reduced value.

For example, if we wanted to compute the total estimated time of the tasks in project, this could become very expensive to recompute if there are large number of tasks in a project (`O(n)` after any update). However, a `Reduced` class can maintain this sum with incremental updates in `O(log n)` time.
```
import { Reduced } from 'cobase'

class ProjectTotalHours extends Reduced.from(TasksByProject) {
	reduceBy(taskA, taskB) {
		return { // the returned value can be passed into subsequent reduceBy calls, so we make it the same type as the inputs
			hours: taskA.hours + taskB.hours
		}
	}
	transform(total) {
		// now finally get just the hours
		return total.hours
	}
}
ProjectTotalHours.for(projectId).valueOf() -> get the total hours of the tasks for a project
```
Note that the `reduceBy` function is slightly different than a JavaScript `reduce` function in that both the inputs may be the output from previous `reduceBy` calls. A `reduceBy` operation must be side-effect free, commutative (order of execution can be rearranged), associative (grouping of execution can rearranged), and referentially transparent (same inputs should always produce same output).

A reduce operation can also be written shorthand from a source entity:
```
const ProjectTotalHours = TasksByProject.reduce((a, b) => ({ number: a.number + b.number }))
```

## Relational Properties
The relational property definitions provide a convenient mechanism for defining related entities, that is built on cobase's index and join functionality. A derived entity, that is transformed/cached from a source entity can be created with the `cacheWith` method, with property definitions that reference other entities. These referencing property relations are defined by the `relatedBy` and `relatesBy` methods. The appropriate index will be created based on the provided foreign key, to join the indices and produce a cached entity based on the joined data. For example, if we had a `Task` and `Project` entity classes, where the `Task` class had a foreign key referencing projects in the `projectId` property, we could create a `ProjectWithTasks` class that included a project and all its associated tasks:
```
class ProjectWithTasks extends Project.cacheWith({
	tasks: Task.relatesBy('projectId')
}) {

}
```

Likewise we could define a `TaskWithProject` that defined an entity with the task and the project data it is associated with:
```
export class TaskWithProject extends Task.cacheWith({
	project: Project.relatedBy('projectId')
})
```
Note the distinct use of the relation definitions:
`TargetEntity.relatesBy(foreignKey)` - This defines a relationship where the foreign key is defined on the `TargetEntity` that will be included as a property. This will add a property with an array of the target entities that reference the parent entity.
`TargetEntity.relatedBy(foreignKey)` - This defines a relationship where the foreign key is defined on source class with a property that will be referencing the `TargetEntity`. This will add a property with a single target entity if there is a single foreign key, or an array of the target entities if the foreign key is an array of ids.

In both cases, the foreign key can be either a single (string or number) value, or an array of values if there is a many-to-many relationship.

## Waiting for completion - `whenUpdatedFrom(SourceEntity)`
In the cobase composition architecture, when an entity is updated, added, or removed, there may be some delay before any indices or reduce-computations are finished, which typically take place asynchronously. If we want to wait for a certain index or other derived entity to be consistent with the data change we have may in another entity class, we can use the `whenUpdatedFrom(SourceEntity)` static method on a target entity class, which will return a promise that resolves when the entity is consistent with any changes that have been made before the call on the source class. For example:
```
Task.set(10, { name: 'Update index', projectId: 12 })
ProjectWithTasks.whenUpdatedFrom(Task).then(() => {
	let project = ProjectWithTasks.get(12) // will have indexed the updated task
})
```
With the latest EcmaScript, you can more naturally write this with `await`.

##

## Integration with an HTTP/Web Server
Cobase provides utilities for efficient delivery of data in a web server. This mainly includes a middleware component (built on Mach) that can perform content negotiation and efficiently stream JSON with support for advanced optimizations including direct binary transfer from the DB to streams, and backpressure. The can be used by including the cobase's `media` export as middleware, and then downstream apps/middleware can access `connection.request.data` for the parsed request data, and the response data can be set on `connection.response.data`, and the middleware will serialize to the appropriate content type as specified by the client (defaulting to JSON).

Additional content/media handlers can be defined by using the exported `mediaTypes` `Map`, and setting a media handler with the content type as the key, and an object with `serialize` and/or `parse` methods as the value:
```
import { mediaTypes, media } from 'cobase'
mediaTypes.set('text/html', {
	serialize(data, connection) {
		return // some HTML we generate from data
	},
	parse(html) {
		// probably wouldn't try to parse HTML from a request, but if we wanted to
	}
})

machApp.use(media)
```
