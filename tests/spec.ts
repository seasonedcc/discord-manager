type Spec = {
  name: string
  run: () => Promise<void>
}

const registeredSpecs: Spec[] = []

function test(name: string, run: () => Promise<void>) {
  registeredSpecs.push({ name, run })
}

function takeRegisteredSpecs() {
  return registeredSpecs.splice(0)
}

export { takeRegisteredSpecs, test }
export type { Spec }
