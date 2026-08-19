declare module "js-yaml" {
  const yaml: {
    load(input: string): unknown;
  };

  export default yaml;
}
