<img src="./assets/alkali-logo.svg?sanitize=true" alt="Alkali" width="100" />
<a href="https://dev.doctorevidence.com/"><img src="./assets/powers-dre.png" width="203" /></a>

Alkali-Base is composable layered system of JavaScript defined data transformations and aggregations for building fast, efficient JavaScript-mapped relational data storage, using Alkali's reactive API for entities. Alkali-DB uses for basic data processing constructs to build scalable relational <data></data>a structured that can be accessed quickly:
* Join
* Transform (Map)
* Index
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
