Alkali-DB is layered system of JavaScript defined data transformations and aggregations for building fast, efficient JavaScript-mapped relational data storage, using Alkali's reactive API for entities. Alkali-DB uses for basic data processing constructs to build scalable relational data structured that can be accessed quickly:
* Transformations (Map)
* Indices
* Aggregations
* Reduce
From these constructs we build join data structures that can aggregate and index data from multiples tables and queried fast, scalable O(log n) time/space.


```

class Task {
	projectId: string
}
class Project {

}

const { From: TaskWithProject, To: ProjectWithTasks } = Join({
	From: Task,
	To: Project,
	joinOn(task) {
		return task.projectId
	}
})


```
