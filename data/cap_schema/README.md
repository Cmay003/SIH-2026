# OASIS CAP 1.2 XML schema (third-party file, unmodified)

`CAP-v1.2.xsd` is the official XML schema of the OASIS Common Alerting
Protocol, version 1.2. It is kept here, byte-for-byte as published, so the
CAP validation test (`tests/test_cap_schema.py`) runs offline and anyone can
reproduce it.

- Source: http://docs.oasis-open.org/emergency/cap/v1.2/CAP-v1.2.xsd
  (downloaded over https from docs.oasis-open.org on 2026-10-09). The CAP 1.2
  specification, section 4.2 "Conformance as a CAP V1.2 Message", names this
  URL: a document is a conforming CAP 1.2 message only if it is valid
  against this schema *and* its element content follows the specification's
  data dictionary. Schema validity is therefore necessary, not sufficient.
- Specification: https://docs.oasis-open.org/emergency/cap/v1.2/CAP-v1.2-os.html
- SHA-256 of the file as downloaded:
  `b7798ef25868b068c97b268bda02d067c7d4ba9373adc5638bf37105804ee723`
- Do not edit the file. To refresh it, download it again from the URL above
  and update the hash here.

## Copyright and licence

The file carries its own notice, `Copyright OASIS Open 2010 All Rights
Reserved`. The CAP 1.2 specification's "Notices" section (copied from
https://docs.oasis-open.org/emergency/cap/v1.2/CAP-v1.2-os.html on
2026-10-09) reads:

> Copyright © OASIS® 2010. All Rights Reserved.
>
> All capitalized terms in the following text have the meanings assigned to
> them in the OASIS Intellectual Property Rights Policy (the "OASIS IPR
> Policy"). The full Policy may be found at the OASIS website.
>
> This document and translations of it may be copied and furnished to
> others, and derivative works that comment on or otherwise explain it or
> assist in its implementation may be prepared, copied, published, and
> distributed, in whole or in part, without restriction of any kind,
> provided that the above copyright notice and this section are included on
> all such copies and derivative works. However, this document itself may
> not be modified in any way, including by removing the copyright notice or
> references to OASIS, except as needed for the purpose of developing any
> document or deliverable produced by an OASIS Technical Committee (in which
> case the rules applicable to copyrights, as set forth in the OASIS IPR
> Policy, must be followed) or as required to translate it into languages
> other than English.
>
> The limited permissions granted above are perpetual and will not be
> revoked by OASIS or its successors or assigns.
>
> This document and the information contained herein is provided on an "AS
> IS" basis and OASIS DISCLAIMS ALL WARRANTIES, EXPRESS OR IMPLIED,
> INCLUDING BUT NOT LIMITED TO ANY WARRANTY THAT THE USE OF THE INFORMATION
> HEREIN WILL NOT INFRINGE ANY OWNERSHIP RIGHTS OR ANY IMPLIED WARRANTIES OF
> MERCHANTABILITY OR FITNESS FOR A PARTICULAR PURPOSE.

The schema is redistributed here unmodified under that notice, only so the
CAP implementation can be tested. (The notice also continues with OASIS's
patent-claim paragraphs, which are about implementations of the standard,
not about copying this file; see the specification page.)
