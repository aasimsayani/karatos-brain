import type { ConnectorCatalogEntry } from "../integrations.js";

/** The catalog fields this connector sets: what it is now that it's built, and what it gives the business. */
export default {
  status: "built",
  note: "Read-only: a token authorized with scope=read, which the connector checks before every sync, turning away one that can write. The client sends only its six listed GETs and never asks for card names or descriptions. No webhooks yet; the sync polls",
  webhooks: false,
  settings: ["TRELLO_API_KEY", "TRELLO_TOKEN"],
  capabilities: [
    "Imports five years of cards from every board you can see, such as repairs, custom orders and buying, then keeps them current",
    "Keeps each card's list, due date, start date, members, labels, checklist progress and number, date, checkbox and dropdown fields",
    "Records each time a card moves between lists, so a repair sitting too long in one list shows up",
    "Notices archived and deleted cards, and who commented when",
    "Never keeps card names, descriptions, comment text or text fields, where customers' names are written",
    "Read-only: KaratOS never creates, moves or changes anything in Trello",
  ],
} satisfies ConnectorCatalogEntry;
