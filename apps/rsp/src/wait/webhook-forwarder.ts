export {
  deliveryMatchesPr,
  deliveryMatchesRun,
  GITHUB_WEBHOOK_DELIVERY_KIND,
  GITHUB_WEBHOOK_SINGLETON,
  type WebhookDelivery,
  type WebhookForwarderOptions,
  type WebhookMode,
} from "@reddb-io/shared/github-webhook.js";

import {
  WebhookForwarder as SharedWebhookForwarder,
  type WebhookForwarderOptions,
} from "@reddb-io/shared/github-webhook.js";
import { terminateProcessTree } from "./process-tree.js";

export class WebhookForwarder extends SharedWebhookForwarder {
  constructor(options: WebhookForwarderOptions) {
    super(options, terminateProcessTree);
  }
}
