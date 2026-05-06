export async function resolve(specifier, context, nextResolve) {
  if (specifier === "pilotswarm-sdk") {
    throw new Error("pilotswarm-sdk was loaded eagerly");
  }
  return nextResolve(specifier, context);
}
