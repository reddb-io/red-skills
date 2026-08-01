export interface CiWorkspacePackage {
  dir: string;
  name: string;
  dependsOn: string[];
}

export interface CiScope {
  mode: "cone" | "whole-workspace";
  trigger: string | null;
  testPackages: string[];
  triggerPackages: string[];
  runTypecheck: boolean;
  runManifestChecks: boolean;
}

export declare function computeCiScope(
  changedFiles: readonly string[],
  graph: readonly CiWorkspacePackage[],
): CiScope;
