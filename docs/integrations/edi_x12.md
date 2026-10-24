### EDI with retail partners

Reads the X12 files a wholesaler or manufacturer exchanges with its retail partners, from the folder where the business's VAN or SFTP mailbox keeps them. Partners send purchase orders, inventory and sell-through; the business sends acknowledgments, ship notices and invoices back, and the mailbox keeps a copy of each. KaratOS reads both sides of the folder and never sends a document, so there are no webhooks and nothing to write back.

| Setting | What it is |
| --- | --- |
| `EDI_IMPORT_DIR` | The folder the mailbox copies X12 files into, outside any git repo |

**What it reads.** Files ending in `.edi`, `.x12`, `.txt` or `.dat`, in name order. One file can hold several interchanges, each with its own delimiters, which are read from its fixed-width ISA segment. Each sync reads the files that are new or changed since the last one, with the same checkpoint as the other file-based connectors, so a crash resumes mid-file. Documents dated more than two years back are skipped. Interchanges marked as test (ISA15 `T`) are skipped, and so are transaction sets it doesn't read, such as 997 functional acknowledgments and 860 order changes.

**Events.**

| Set | Event | From the partner or the business | Date | Document number |
| --- | --- | --- | --- | --- |
| 850 | `edi.purchase_order_received` | Partner | BEG05 | BEG03 |
| 855 | `edi.purchase_order_acknowledged` | Business | BAK09, or BAK04 when there is none | BAK03 |
| 856 | `edi.shipment_noticed` | Business | BSN03 | BSN02 |
| 810 | `edi.invoice_sent` | Business | BIG01 | BIG02 |
| 846 | `edi.inventory_reported` | Partner | BIA04 | BIA03 |
| 852 | `edi.sell_through_reported` | Partner | XQ03 | XQ02 to XQ03 |

Every event carries `partnerId` (the qualifier and ID of the other side: the ISA sender for what partners send, the receiver for what the business sent) and `sourceDocument` (`file.edi:<ISA13>:<ST02>`). Lines carry the item number (VN, VA or VP first, then SK, BP or IN), the UPC (UP, UK or EN) when there is one, and every product ID pair as `ids`. Orders and invoices keep quantity, unit and unit price; ship notices keep each item under the order its HL loop belongs to, with carrier, bill of lading and tracking number; acknowledgments keep each line's ACK status (accepted, backordered, rejected and so on); 846 keeps each QTY code and quantity; 852 keeps each ZA activity code with store quantities from SDQ, added up when ZA leaves the total out. Prices read without floating point, half a cent rounded away from zero; SAC and TDS amounts use X12's two implied decimals.

The key is the partner, the set, the document number and a hash of the document's segments. The same order delivered again, even in a new file with new control numbers, is a duplicate; a changed order is a new event.

**When something doesn't add up.** An envelope whose IEA or GE count or control number is wrong, or a file cut off mid-interchange, stops the sync with the file and the problem named, since nothing in it can be trusted. A single document that can't be read (a wrong SE count, a missing PO number, a date that isn't CCYYMMDD, a quantity that isn't a number) is kept with its `problems` listed and no time, so the pipeline dead-letters just that document with the raw event kept.

**Writes.** Sending an 855, 856 or 810 is declared behind the write gate as `send_po_acknowledgment`, `send_ship_notice` and `send_invoice`, and the gate turns each one down while writes are off. Nothing sends them yet.

**What it leaves out.** Names and addresses in N1 to N4 are never stored: a ship-to store or reporting location is kept as its code only. No department reasons over these events yet; they are stored for the wholesale views to come.

**Testing.** The tests build synthetic interchanges in code, including other delimiters, several interchanges per file, every envelope error, and a broken document of each set.
