import { ANNOTATION_SDK } from "./annotation-sdk.js";
import { LAYOUT_AUDIT_SDK } from "./layout-audit-sdk.js";

/**
 * Injects the annotation and layout-audit SDKs into an HTML artifact.
 *
 * Scripts are inserted immediately before `</body>` (or appended if the tag is
 * absent).  The `__BRIDGE_URL__` placeholder in each SDK is replaced with the
 * actual bridge server origin so fetch calls land on the right host:port.
 */
export function injectBridgeSdk(html: string, bridgeUrl: string): string {
  const annotationScript = ANNOTATION_SDK.replaceAll("__BRIDGE_URL__", bridgeUrl);
  const auditScript = LAYOUT_AUDIT_SDK.replaceAll("__BRIDGE_URL__", bridgeUrl);
  const scripts =
    `<script>\n${annotationScript}\n</script>\n` +
    `<script>\n${auditScript}\n</script>\n`;

  const closeBody = html.lastIndexOf("</body>");
  if (closeBody !== -1) {
    return html.slice(0, closeBody) + scripts + html.slice(closeBody);
  }
  return html + scripts;
}
