# Third-party notices

Sodilaud's optional update checker uses [reqwest](https://github.com/seanmonstar/reqwest)
and [semver](https://github.com/dtolnay/semver), each available under the MIT or
Apache License 2.0. HTTPS is provided by rustls and its platform certificate verifier.
The release manifest generator uses [node-semver](https://github.com/npm/node-semver)
under the ISC License; it is a build dependency and is not bundled in the app.

Sodilaud includes [Marked](https://github.com/markedjs/marked), a Markdown parser.

Copyright (c) 2018+, MarkedJS
Copyright (c) 2011-2018, Christopher Jeffrey

Marked is distributed under the MIT License:

> Permission is hereby granted, free of charge, to any person obtaining a copy
> of this software and associated documentation files (the "Software"), to deal
> in the Software without restriction, including without limitation the rights
> to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
> copies of the Software, and to permit persons to whom the Software is
> furnished to do so, subject to the following conditions:
>
> The above copyright notice and this permission notice shall be included in all
> copies or substantial portions of the Software.
>
> THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
> IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
> FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
> AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
> LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
> OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
> SOFTWARE.

Marked also incorporates Markdown-related material under the following terms:

Copyright © 2004, John Gruber
http://daringfireball.net/
All rights reserved.

Redistribution and use in source and binary forms, with or without modification,
are permitted provided that the following conditions are met:

- Redistributions of source code must retain the above copyright notice, this
  list of conditions and the following disclaimer.
- Redistributions in binary form must reproduce the above copyright notice,
  this list of conditions and the following disclaimer in the documentation
  and/or other materials provided with the distribution.
- Neither the name “Markdown” nor the names of its contributors may be used to
  endorse or promote products derived from this software without specific prior
  written permission.

This software is provided by the copyright holders and contributors “as is” and
any express or implied warranties, including, but not limited to, the implied
warranties of merchantability and fitness for a particular purpose are
disclaimed. In no event shall the copyright owner or contributors be liable for
any direct, indirect, incidental, special, exemplary, or consequential damages
(including, but not limited to, procurement of substitute goods or services;
loss of use, data, or profits; or business interruption) however caused and on
any theory of liability, whether in contract, strict liability, or tort
(including negligence or otherwise) arising in any way out of the use of this
software, even if advised of the possibility of such damage.

## Highlight.js

Sodilaud includes [Highlight.js](https://github.com/highlightjs/highlight.js),
a syntax highlighter, under the BSD 3-Clause License:

Copyright (c) 2006, Ivan Sagalaev. All rights reserved.

Redistribution and use in source and binary forms, with or without modification,
are permitted provided that the following conditions are met:

1. Redistributions of source code must retain the above copyright notice, this
   list of conditions and the following disclaimer.
2. Redistributions in binary form must reproduce the above copyright notice,
   this list of conditions and the following disclaimer in the documentation
   and/or other materials provided with the distribution.
3. Neither the name of the copyright holder nor the names of its contributors
   may be used to endorse or promote products derived from this software without
   specific prior written permission.

THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS" AND
ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE IMPLIED
WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE ARE
DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT HOLDER OR CONTRIBUTORS BE LIABLE FOR
ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL DAMAGES
(INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR SERVICES;
LOSS OF USE, DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER CAUSED AND ON
ANY THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY, OR TORT
(INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE OF THIS
SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.

## Rust SDK for the Model Context Protocol

Sodilaud's optional agent access uses
[rmcp](https://github.com/modelcontextprotocol/rust-sdk), the official Rust SDK
for the Model Context Protocol, under the Apache License 2.0. The license text
is available at <https://www.apache.org/licenses/LICENSE-2.0>.

## jsdiff

Sodilaud includes [jsdiff](https://github.com/kpdecker/jsdiff), a text
comparison library, under the BSD 3-Clause License:

Copyright (c) 2009-2015, Kevin Decker
All rights reserved.

Redistribution and use in source and binary forms, with or without
modification, are permitted provided that the following conditions are met:

1. Redistributions of source code must retain the above copyright notice,
   this list of conditions and the following disclaimer.
2. Redistributions in binary form must reproduce the above copyright notice,
   this list of conditions and the following disclaimer in the documentation
   and/or other materials provided with the distribution.
3. Neither the name of the copyright holder nor the names of its contributors
   may be used to endorse or promote products derived from this software
   without specific prior written permission.

THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS" AND
ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE IMPLIED
WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE ARE
DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT HOLDER OR CONTRIBUTORS BE LIABLE FOR
ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL DAMAGES
(INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR SERVICES;
LOSS OF USE, DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER CAUSED AND ON
ANY THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY, OR TORT
(INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE OF THIS
SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.

## CodeMirror and Lezer

Sodilaud includes [CodeMirror 6](https://codemirror.net/) (`@codemirror/state`,
`@codemirror/view`, `@codemirror/language`, `@codemirror/commands`,
`@codemirror/collab`) and
[Lezer](https://lezer.codemirror.net/) (`@lezer/markdown`, `@lezer/highlight`,
and their dependencies `@lezer/common`, `@lezer/lr`, `style-mod`,
`w3c-keyname`, `crelt`, and `@marijn/find-cluster-break`), under the MIT
License:

Copyright (C) 2018-2021 by Marijn Haverbeke <marijn@haverbeke.berlin> and others

`@marijn/find-cluster-break`: Copyright (C) 2024 by Marijn Haverbeke
<marijn@haverbeke.berlin>

> Permission is hereby granted, free of charge, to any person obtaining a copy
> of this software and associated documentation files (the "Software"), to deal
> in the Software without restriction, including without limitation the rights
> to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
> copies of the Software, and to permit persons to whom the Software is
> furnished to do so, subject to the following conditions:
>
> The above copyright notice and this permission notice shall be included in
> all copies or substantial portions of the Software.
>
> THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
> IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
> FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
> AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
> LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
> OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
> SOFTWARE.

## Mermaid

Sodilaud includes [Mermaid](https://github.com/mermaid-js/mermaid) 12.1, loaded only when a
document has a Mermaid diagram. Mermaid is distributed under the MIT License:

Copyright (c) 2014 - 2022 Knut Sveidqvist

The MIT License text is reproduced in the CodeMirror and Lezer section above.

Mermaid's prebuilt bundle incorporates the following libraries. Their copyright notices are
kept in each package's license file in the Mermaid distribution.

- MIT License: `@braintree/sanitize-url`, `@iconify/utils`, `@mermaid-js/parser`,
  `@upsetjs/venn.js`, `cose-base`, `cytoscape`, `cytoscape-cose-bilkent`, `cytoscape-fcose`,
  `dagre-d3-es`, `dayjs`, `es-toolkit`, `hachure-fill`, `katex`, `khroma`, `layout-base`,
  `lodash-es`, `marked`, `path-data-parser`, `points-on-curve`, `points-on-path`, `roughjs`,
  `stylis`, `ts-dedent`, `uuid`.
- ISC License: `d3` and its modules (`d3-array`, `d3-axis`, `d3-brush`, `d3-chord`,
  `d3-color`, `d3-contour`, `d3-delaunay`, `d3-dispatch`, `d3-drag`, `d3-dsv`, `d3-fetch`,
  `d3-force`, `d3-format`, `d3-geo`, `d3-hierarchy`, `d3-interpolate`, `d3-path`,
  `d3-polygon`, `d3-quadtree`, `d3-random`, `d3-scale`, `d3-scale-chromatic`, `d3-selection`,
  `d3-shape`, `d3-time`, `d3-time-format`, `d3-timer`, `d3-transition`, `d3-zoom`),
  `delaunator`, `internmap`.
- BSD 3-Clause License: `d3-ease`, `d3-sankey`, and the older `d3-array`, `d3-path` and
  `d3-shape` that `d3-sankey` uses.
- Apache License 2.0: `chevrotain` and its `@chevrotain/*` packages.
- DOMPurify, under the Apache License 2.0 (it is dual-licensed MPL-2.0 or Apache-2.0).
- The Unlicense: `robust-predicates`.

The ELK layout engine (`elkjs`, EPL-2.0) that Mermaid can use is not included.

ISC License:

> Permission to use, copy, modify, and/or distribute this software for any purpose with or
> without fee is hereby granted, provided that the above copyright notice and this permission
> notice appear in all copies.
>
> THE SOFTWARE IS PROVIDED "AS IS" AND THE AUTHOR DISCLAIMS ALL WARRANTIES WITH REGARD TO THIS
> SOFTWARE INCLUDING ALL IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS. IN NO EVENT SHALL
> THE AUTHOR BE LIABLE FOR ANY SPECIAL, DIRECT, INDIRECT, OR CONSEQUENTIAL DAMAGES OR ANY
> DAMAGES WHATSOEVER RESULTING FROM LOSS OF USE, DATA OR PROFITS, WHETHER IN AN ACTION OF
> CONTRACT, NEGLIGENCE OR OTHER TORTIOUS ACTION, ARISING OUT OF OR IN CONNECTION WITH THE USE
> OR PERFORMANCE OF THIS SOFTWARE.

The BSD 3-Clause License text is reproduced in the Highlight.js section above. The Apache
License 2.0 is available at <https://www.apache.org/licenses/LICENSE-2.0>.
