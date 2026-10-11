// SPDX-License-Identifier: MIT
// code.js, Tern's code highlighting add-on (docs/addons.html#code). It
// colours each fence and listing whose language highlight.js knows, once
// the note has mounted, in the page theme's code colours: the --t-code-*
// properties of tern.css, which the themes in themes/ set too.
//
//   <script src="tern.js" data-use="addons/code.js"></script>
//
// highlight.js comes from jsDelivr, pinned with SRI (the table below): its
// common bundle as soon as this add-on runs, any other language on first
// use. `?base=URL` names a copy of @highlightjs/cdn-assets instead (the
// folder of highlight.min.js and languages/), loaded without SRI. A
// window.hljs already on the page is used as it is, with its own languages
// only. Line numbers and highlighted lines keep their spans: the coloured
// text is split back into them.
//
// Under node (tern check, tern build, the language server) it only adds its
// styles: highlighting needs the page.
(function () {
  'use strict';
  const T = window.tern;
  if (!T) return;

  // <hljs> written by tools/hljs.js; do not edit by hand
  const HLJS = {
    version: '11.12.0',
    core: 'sha384-wjfDDhOPPdjtva8vWBhWeVprSpmxisEu5aYT3q1JyACqXpdKpo3PWZTMVq24MBix',
    // In the core: bash c cpp csharp css diff go graphql ini java javascript json kotlin less lua makefile markdown objectivec perl php php-template plaintext python python-repl r ruby rust scss shell sql swift typescript vbnet wasm xml yaml.
    // The others, loaded on first use: name: [SRI of languages/NAME.min.js, ...aliases].
    languages: {
      "1c": ["sha384-0dEOKwfMDCQjiskq0W/EY0WUrffrp1sMioAlHDExIHbFB/He9msytFsqVzFAAwgD"],
      "abnf": ["sha384-FXzSjPUGeHjiR6Xqkyg5VYhDcu699UrsffgfbQ8eWOMxS7wefq6u4FanwSAjMqC5"],
      "accesslog": ["sha384-bG/6dXLz6Su49NXLKaZ6gCNHJLZEYJCBC6L2uFC7FymcYiXa+mWaHT5f5niJWf2J"],
      "actionscript": ["sha384-9x3tLiEFYbGRxL2aW2dE4bBLIC2ikrzq3hDr0QhY6o3wOBeOqccOlN5CdQtw3TtU", "as"],
      "ada": ["sha384-jhYDVknGeZezdLAK9F/+PVHdfTsHQx/8ceOATkW5vch1qWvMj1d8f8yRxu8F9uZU"],
      "angelscript": ["sha384-eS14DqT/Hn+h7VImaaNcfRwvD0x0thQKkYt2NjsPYvOXHjBbd8pY8u7it8Rop/um", "asc"],
      "apache": ["sha384-QraNZk4EDfTVeWmClFLg5BZNVnDF8kF6L0wgGHxg201ohjeXkPbNzC5dzdpjxdnB", "apacheconf"],
      "applescript": ["sha384-sHEGnomo/lWUBg5I8TICidwswwIA/xv83CJu2P5EPOeM/GouFNz0DqApK1rXyR+X", "osascript"],
      "arcade": ["sha384-rOtRAS0OD08WHxvsw5rVsm42uYKtAqNr0LupkmvItimfNC9yey6QC+eSBPWeewet"],
      "arduino": ["sha384-E6FJkg0YQwr6DdDR0LLLYf7x4jf5uhy73koai3bqN25Mw307x8y1ERpV1kpK7o17", "ino"],
      "armasm": ["sha384-lPVdJSvbOCURN6N0fEp7MDhI9mRVUZffGHI6I63SY8afZiqUxOPAwnUeuWmTDgkC", "arm"],
      "asciidoc": ["sha384-lNQ5H7q4BZECipdS2g8FzHQm0Fqi0O8bb9SE8zJ2qlSrEaQcybfGCarQ71Oj6o0R", "adoc"],
      "aspectj": ["sha384-H+o9fKU23Vvx1mSPmVHf2wmhzm87eve67KRs2WMckK2npr0tLOynNF3RUyMLw9u7"],
      "autohotkey": ["sha384-ETU9ophSb0GK/xgHFcGYMaf/7Xufu0TKDpmyumud5YRR6tX1m8xStyA/8hdGNp+6", "ahk"],
      "autoit": ["sha384-Sbt2je4y9ZaA7ZS1i/fp7UeAoG1QmeVjB7ZuyWfDJC6Yrlmj0Sqh9ZPOtaJJkm3/"],
      "avrasm": ["sha384-+am0iA2QGpg6L06g3XfD4SiigInt/+GXpyW6Og6heUd0fJjexL5BWUc/mxrPBLAc"],
      "awk": ["sha384-fMmTpnt13E+OHdNVNrGGh8dQn7suHkyJqXK3gZHJc/JbDk9QTmpo4l8lmxduLuT3"],
      "axapta": ["sha384-82uq922/34e1t7kUAnlqzTgfZYNGOagCr8ncXe2CXMLPRVKHkeI9ox3E23eUuD8V", "x++"],
      "basic": ["sha384-FY2WbFC0MWOkOmPYdCtW5yYLOFdbA15A6W7w/NUN8bgxyOxBFRp/KuWVkxHJzNA/"],
      "bnf": ["sha384-Y03dArsKeMrGwpVX6QCDOakY1f0URmRusH9MeHeJTZuas3f2PmqZQmqdr4lHmxNq"],
      "brainfuck": ["sha384-F8zIwjSEu5xB+rnbqwb1UvoFj3VZ8wEl5PHFgGjL8WxwqE5U0aBWVrUO0dyJSyWF", "bf"],
      "cal": ["sha384-vmDBweDvmEqidY+ZDWczJffF/pIGBeFlQTut7M/x/0LHWCh5oC2Ma2T/91EU5gz3"],
      "capnproto": ["sha384-8bOy3ubemWYxm9rxlBMy2bZ1NsUOmYQoat/Bfg72eAcE0fk5oImNGP3By4dfbDVz", "capnp"],
      "ceylon": ["sha384-krTIAgwQ/++ru5IvZ1XgtUo0myP2OkCfanpHRZwIHCEfDpvjHosb+5J3tm5APFM1"],
      "clean": ["sha384-XL4iQcDSwrpTY3gzSgQ4PFvbbrK+4Jovmq4h5IIBbhLasA40RmmnrA8kVie5GEJP", "icl", "dcl"],
      "clojure-repl": ["sha384-pV4ACrf3iOv5wCu3/yZ1Ygku8jWQBMUpYd0RZwRFW1uo6kKnw9XRdScX7uAH4UGO"],
      "clojure": ["sha384-5FYEb05i3NG1q8w76Ak5/2HAiF2Yw1428YR0YbS1mezlHl8HPolqt7RR7Ob8Pzoa", "clj", "edn"],
      "cmake": ["sha384-2+d+VUsqaxDE3yoeRJxqWmX1dF5Ongwq0zKRb+NmBsIQXlRr0GTQOkDDD6eujd4k", "cmake.in"],
      "coffeescript": ["sha384-yrDrCtmo8etajTcWsAFTXXy2lvhgjM8jMtC1z6L7GpN/PT6aKWV+KOG6lU5U7Uo0", "coffee", "cson", "iced"],
      "coq": ["sha384-0t/U+jKUwNGBMz+jigZWD22/cnBv9hx14YTCafL0lu3xsXZWMM23SQUIPKBhoZJJ"],
      "cos": ["sha384-/qPSbF1akbxjHjQf7bOhIRXLZgNJoWw8niSlJZZyBbO/B8RImuhUSsT9x5cUP9V2", "cls"],
      "crmsh": ["sha384-E7L2u7n7GUbz1MXC1S6zg4+s6rjbsqKI5xwY7w3p3J1Ta0vR6X1p1afJngI5nqBC", "crm", "pcmk"],
      "crystal": ["sha384-OG9G2vQgic2ttJmLFSa20DUnq9PVRVfDzL1kp0n8Kn3LqwkJHgJU8ZOJGbHtSemk", "cr"],
      "csp": ["sha384-jMr7+vSjFN1KTFNnda+KOWis54jQMePKxY0ZJlY6xnCivezo9FQt4/cb75LIZ4oC"],
      "d": ["sha384-TWra7B89iv3+66u3qcxxg+96U4d+EeRMBZeHqUium1ttSIZWal995eWGrBcDKjqq"],
      "dart": ["sha384-m692RDTeyWok7r6KORdic5N2fD4sqVvyPrwZsS1U6CKcx7d3Kw88TvlMnSVPIFba"],
      "delphi": ["sha384-Exb4Oc6c5Ij2XVX61DwugOd4tsupIyy3qfq7xWQCLe3fJEtCoV1W+/NR+ZDB+N/d", "dpr", "dfm", "pas", "pascal"],
      "django": ["sha384-iCQMVBDvaK7uW9unjuim0DlLN7Jwk+qOtE8tAOVrjsp38zhncxewwgOc4G6hxFLE", "jinja"],
      "dns": ["sha384-PwqNa5d0HtCty8ZGcWhEKnB5EZMQlsbFPo3KQ8SSlgI/nYMiJDr827UC5DoH5SHa", "bind", "zone"],
      "dockerfile": ["sha384-/zu1pI8+9j/v/qNlCRRyidiBhGdxfvGwOLXEPBXpKc77eFNUAhccr0WglEQ+x9La", "docker"],
      "dos": ["sha384-OP6ey9zMpJWPVgF9AGbxxfHDX5xCrPeJuM9x1nAZXFMNjzNz3xOUrRtphSL+N3h3", "bat", "batch", "cmd"],
      "dsconfig": ["sha384-+GHqzlK5aZupzzIEqbB/qPw98otJ/iGERYerZlGOnruCrR+igVglD5TSmdBnAN84"],
      "dts": ["sha384-r2Sig3wjLrzZlYfjdtpqhQd0dcy0i2qeW0Cb+N1YP9DGMZTSQzoVoO9CJCW87aGU"],
      "dust": ["sha384-YxagUvN2fZdTSEehRxc7l2VRMrf+ugybWxa84Uc2VTH+KFYgKN501D/uOVnoO3Kz", "dst"],
      "ebnf": ["sha384-aCUVIjvl2rogTdwHA4g5Zqv/t+yjx+rGbawUrsQvod5u1Q2+8m6aaep47Gj92NHx"],
      "elixir": ["sha384-rSOGzFmdaGExhx6WbibC/dE+Pdl0aqugcyUKj5yiT2Gxf4BQVIKdL0bwry1c31Ux", "ex", "exs"],
      "elm": ["sha384-hs4dZwWxSJrpxD9pl+8bxS3eASv5D8ZMeX4lsxA1F2D3ogZYR+OCYUmBwNeujPf9"],
      "erb": ["sha384-xB8oLM0LrPv+htjhcmtkA56WWSgOP63K6ViZz9w42VHteQYbj6RvvREIhpoDOLZ2"],
      "erlang-repl": ["sha384-KP7Mlg3LtFTdlil6xhIhhSF/vEtsvhr6fPRZFkZsrkKQknUlYOVGbjw0PkHHM7C5"],
      "erlang": ["sha384-nQ2ULvfpV6vH0atPFJwG6BJgCeCt9Pg1Nx1EnsJELoO2u7D3hfyDPgLOtxHtPA+w", "erl"],
      "excel": ["sha384-58/fdyRU4xnHhJjtucGxcmuREWKSkYeGELj5LoqjS2pk2/HxrKXfTWIFdShavX71", "xlsx", "xls"],
      "fix": ["sha384-ldXyjW3xyU33gaiaepCcxaTUx3c+J9blAhWmu3dM7zroi6DJtT7JSc+9kRz+WnMA"],
      "flix": ["sha384-OM/h+Uw48vU4oxzXcfmbmhSnjuexVK5cu2G6e4ik/CZCuJ2JxdnS/Jr0oWTIQv6Y"],
      "fortran": ["sha384-w5JXWi0B42BKEfpqDLgy0wBSgI6JzYBT3SV12nBjFnJT3YCdvmdS6k9BtcwOe39J", "f90", "f95"],
      "freedesktop": ["sha384-XjjUVKQ2Fx8YJy5LVeKGC4fPTIIpAlazSKxo7byd66vgDpebwYntjjoZWzC3RIyX", "desktop", "systemd"],
      "fsharp": ["sha384-497P//su89C+0b52jLnsXDpvjDqVAcOCeeVpH8tF2ZoPawmI9zMcV7immAWa31Ou", "fs", "f#"],
      "gams": ["sha384-Nx52aykgVC4vrHLghZ3Kkn7GHrWYeShkiWuZ1t6M4+fiWT4lgI06hI0S9NdYKuNp", "gms"],
      "gauss": ["sha384-8sReisoQGjQli1Ia+TGArpj0o1k3NklVdNmmFNSoD2dHgfhXDTg0LAr1OkIZvdX6", "gss"],
      "gcode": ["sha384-5nVtxRRtNqyNVeeOUvL6T8lG3mzOD6p4+FxGRTPxdWFgCQB1WUgf8Ra46AuCwzJ1", "nc"],
      "gherkin": ["sha384-nvNtLf3hmt8LjP5Z+rza+Li8AWt59cWAf4A8dQBTMNdJtAUGkTo+q0U5Pk8rDBEK", "feature"],
      "glsl": ["sha384-XiS1+JPWHSXaiCUiJCajSKauKAAgJOpuw9JaBRiwU3b/MOLvB6WWi59K+xFGI6hn"],
      "gml": ["sha384-CRyja0w2eRMQEFeDkK949rRHnLAjmHt7t3yUDRwLlIvC2uTsUbMA7iobj50T8Gi9"],
      "golo": ["sha384-E/RDk+3zW2qYv09FHgdHh7TtJVapeQYqHysvsmK3SWJ2Crfsds7XvuaXwjsY6Bto"],
      "gradle": ["sha384-ZMf1TkmgwGuFpXWyanMnGiBQS/hdqUrJkNZfPm3GZ/CGypwNzesT3EX03iY30WN5"],
      "groovy": ["sha384-T3pAOCMtlhvbttiHMLES5r/LSOZUGYphLrWRjZt+2XskLDHrwjQQzJShJanN1D2Q"],
      "haml": ["sha384-6N2TCpz6V/kvbDp6AsMV6xOcyY4+1J/z6iBFw6a405Mfv1eEiOgRrfaw1IEFRchr"],
      "handlebars": ["sha384-OOl6xUfRcwlzD1VVtlM2i4n1wVh5jG7PQu0yVmLHoIPNE4U2YaQas5gz7Pc3n5qP", "hbs", "html.hbs", "html.handlebars", "htmlbars"],
      "haskell": ["sha384-L8WB9gHpfiTBWE1ygjEnc4V2QF5dazO17LzcqDfOFEmJeRo5udFESxWTuGIlURhX", "hs"],
      "haxe": ["sha384-N9gjEANo1hbrQIHo0/+VvK31tqQZ1TilMvHNBOpev/J9MP+d/3Yx3p/IKYnHwYVG", "hx"],
      "hsp": ["sha384-JOONVydeQKsz5MvrjkYiDqrOZI0ZZegI7tf+TxfQDh8yOUawZd03iNh1D9gur9wh"],
      "http": ["sha384-L0lAPMci4/TxXazgm0dJIgX9udJzIJf78sk4o9v5sYuRVYJSjymFXF13LmyCU3L0", "https"],
      "hy": ["sha384-PETjfN6FFVKh5dCnompPmM3BX85AQsr+LsGj0wLt0JfQ8vaU/Gob3U8ODe1YOZ10", "hylang"],
      "inform7": ["sha384-0Jt2EHtMk2AjX/t2Kg9LXGP+TJ2AOa6VygjjvFjpm2rnav6tEx7cWspEi4uYBOfs", "i7"],
      "irpf90": ["sha384-/WBL0JdxWFJEQfGEvaTX3uVHjN1JUD5SFh0o+w3iTRmn+bt9dJA8qywuaO8Svu18"],
      "isbl": ["sha384-bx8TUVAa2+3UQu+xFm4+xAaFFbJg13ysCPhvepwlmEDwhuZst/tHlv9p+tLOWq9I"],
      "jboss-cli": ["sha384-1E3U2kengWtJ4opeOFUfh76gobcyLmJ7DzFkfwDjA8ycIO4t+0Hx/vDVpHL9o+2d", "wildfly-cli"],
      "julia-repl": ["sha384-2qpW1IcQCJpwQyZ6Ksmy/LuTAG6Q6R1NLf++Dt1+IHUw1Vl0wcf+pKW3nSyMVBai", "jldoctest"],
      "julia": ["sha384-v2gCXTWc4kL+pNpB1AA9sem3usnVLY2uTl7/sWrQpMYl4FKFUECFCrHFo8WNPz43"],
      "lasso": ["sha384-e+176D/Jphp5ob9A7r0l4X2d3vO2B+ElFHrSAzcQsXODzAv04Osjm/VVBEI3iJsk", "lassoscript"],
      "latex": ["sha384-wHW9Hcxw0oenHF2z8fGo1rhAe1jZwnp35Z6xzC29Vj/O+toSfBY9+7TrUfUnwFMD", "tex"],
      "ldif": ["sha384-EH87aPFtrH+4fMdID3GC+9RbcRmuvMSF8ElVi6kitt9mmOAsUI8sLA0B3JGIrb3R"],
      "leaf": ["sha384-sjsb15sfgYtysTYuoD8z9EQSXx3jWkTFMk+mSC3MJTZ8wLkWeQKGwhKzwZ/7FEPg"],
      "lisp": ["sha384-JPkK+3oG1Os0vhKRFRZnvEH6NeoWJn8y9pDddmqFOOMjNV+Y4BEB4WtG9Yf2/JG7"],
      "livecodeserver": ["sha384-IR2nBcj8QxkSj7T6fDmcvKiJYBeF1t6b5BDPVc2G5iAPsaBC0ooO2qGfj8j8tBbs"],
      "livescript": ["sha384-kpBBD3YO57PPpg+jmPy9NSlDETByiBAACqrf2njpF2m6vMtCvEL0IMDeKftnxZcH"],
      "llvm": ["sha384-Sjmz0kyLR+Sa04KhOZIdr2mgpISO5awi4vjMFx1YJWYM2nTDkqGVLowiK4eBbzvB"],
      "lsl": ["sha384-lXxJYwHPcbBA/BVinPI0ggMvTpPxZdX73ISlerBKfXPHMdUAtIinHpBdj1wUwrY2"],
      "mathematica": ["sha384-SkgIDZle1CBMv93kQr+lZMbPfOz3ODJ2S1PY0d8o5zgYSk/ZUabNDieQ2Qwf7/hk", "mma", "wl"],
      "matlab": ["sha384-bzbYzqp5kO+6yS3NUZAEd8SfG2UtZyk9yuhsZ9233T1+Cps0iE9rEW2fQ1IaeMfw"],
      "maxima": ["sha384-z3QbRfMZ8TX+9PGiTX637SbBlWZ0Nf0JvYbAi8gevbSl2AOD4N4ffirIN4GLZASo"],
      "mel": ["sha384-1TV4fzcJtpgmlP8TF+/74SRmhH/rNrxGzk61e+kJGbE5FivBfs7kaoMutK4yIMx0"],
      "mercury": ["sha384-R/v9nikFWXUdx8sHGGGPTpY48ehSgytKVrNJgPpDEOVcITGi7aLFPI7L2nrfn83A", "m", "moo"],
      "mipsasm": ["sha384-g8wYLhH4oM5Lg288Gd8otNCsksUqJlmvOOIY04zO9ozZtGXXWz/y9D/SDul0e0ki", "mips"],
      "mizar": ["sha384-3gUbMR6+YiCxSWc52LfpvL1CYbYX7t39nSaEfV8HwJMiedGLSSvKrrZAtHTkAITg"],
      "mojolicious": ["sha384-bVi9YbphtOq8GZWk0oA4rIjAaK/l68uVRiFE2VJT4IcM6EJhfW+0YvFJyFMahHz3"],
      "monkey": ["sha384-8OYsUrCQU5pgSZ9x0mASwrMMt3bl2nwUvV4uE/5VkFsh5vt3iKhGvwug4Jr+A0Yc"],
      "moonscript": ["sha384-B4d7ivaqTmb0QYUbwMSXyqaWtImzix+UNLdDLjb47CGT4qesOjEchIvQS9eeFOpl", "moon"],
      "n1ql": ["sha384-1yjhp01gETUG4Q8Efxo79JxMbqN4w7NAC9JmrJHlCvhpMIx0ZmlnmVdwo0ZCBCBT"],
      "nestedtext": ["sha384-11xZ6kUS6tgp9zbTyxbxs+6ejsUtN4YElJ0u1bpRmnnK+pNsT8NR+Xs7QC+2qp4/", "nt"],
      "nginx": ["sha384-fTqzvE/t2lypa5UdKpG8P3qlAUy1xlle9ZtJj8r+9V9aRP/ePjUW7IWAHlU8phrY", "nginxconf"],
      "nim": ["sha384-/esAhw2CBNyggVNEgyR9miFl8F5Z1KHbvUskNou3t5UjM50M3te71zsSwHUCFwIX"],
      "nix": ["sha384-9VYvb3RrbMDUx+Q/q8C9UVFF8yptNO5ShBGaKg11bpzI6hfy3G8cEQ7m1zciLjR5", "nixos"],
      "node-repl": ["sha384-gjlmsDX+YwpYnPwAHr1v12+ljEPGwTHc9fpuImOXysDmu6wYpnGaWZFEIrv8uXaS"],
      "nsis": ["sha384-B061gU7v5RmwkwcDwAVb7BoMySU5vvn5mdHrP60WNIAO4QbVEm6cBHzH34EBJVS4"],
      "ocaml": ["sha384-74s/hsaCRSaXFO4K7hl5vtCAx390VPb1iovzm5RrDuHzsbD78KWUJAVtny1kKcfi"],
      "openscad": ["sha384-yqtSBCDG7NhqBcgbadg2zPcgF5bQLiO+U+/t7/De7GxTBbfVNii5VbP9fRS+K9mk", "scad"],
      "oxygene": ["sha384-IEnT+s4LC6SXYN5/+7QBS5aRe7Xy7nzOAjtwJwwmC7wLckcOmA+PwPN2duSzc9Du"],
      "parser3": ["sha384-X8XvkxduxrgcMxdn3soh3eNDlkdIXzWY1DCvxnCGyobf+Ll6bIXwDhajC6zkGVcu"],
      "pf": ["sha384-wzYeNpgfadnWIjjJ5olZjtDvficoGZKk+75OBv7In1icOtPUkU0N8e7ihDN0hp2f", "pf.conf"],
      "pgsql": ["sha384-9rdIc+nt3LnsQUdyROz7e1pHsM27CXAhtRaGo0AhyHxGCsSCRLE64xeMNrpcASNy", "postgres", "postgresql"],
      "pony": ["sha384-Ncu/rD2poreNtDp6nlOO3YAXqttpv2Qh8Wp4ye3oeL3PUq+4WfGm8f9LMTVTWB1e"],
      "powershell": ["sha384-jigawbLJjSW9uklht6/lvMBC7b00t25Id0RQW+qORcsF6B+LARvlTLfzyIaNolYG", "pwsh", "ps", "ps1"],
      "processing": ["sha384-I34lXT06xntDsynPnzg0T2QTEntKhyxGm/2H52WezVbz1nQtEv44wi+YxDJSZWLc", "pde"],
      "profile": ["sha384-Y3cXEtElZcbKVMFgbXHjz9uuiW2GUl4imkasPyME+ri6E6aW/DoXVxzSqgnUfVfv"],
      "prolog": ["sha384-AM7OGQmAMFXlV/dGATlR5DpUaO22ei6nU7SqwpChP3gzsWXQu0RiuNa0NG4hwV9T"],
      "properties": ["sha384-xHbFPM8P0rCZ1js6aFBqwyDdUMK35/FEbVS6ZSdPtDjssqs17QJ2/M9kWJJUbm3D"],
      "protobuf": ["sha384-+0RAXIR4LRTtbuX1B+TJHkhS4Id4ro/sNetpSgoMpx4Q8gR/sadGTftPY3PcIi2U", "proto"],
      "puppet": ["sha384-GSQqBjn2Rhf/9jdAw6FHxoug5rHjxY2t7PA3k0pnziwD4KENqmFluLFl84WKkCtx", "pp"],
      "purebasic": ["sha384-35FCiDO28KyogL+RV6G8ensBJkwr0WACujMaemdmoeQjaD9Mh3YWy/ucRIMkewK0", "pb", "pbi"],
      "q": ["sha384-53GmvnPKSHpVvnv0FpCVKE1frddMLt7iZ0s/Tby/ZlSkYHCUUHVi0JQUwH8BW4vi", "k", "kdb"],
      "qml": ["sha384-uO/9qnqAnQ2HsnBXg5YK8VsPDbPTFI50fAtp9Z8tAe1aKeJvlTDCdNqzvIuGjh1y", "qt"],
      "reasonml": ["sha384-sFdZmXaDI+Al/KDi/9vanieo8MOzI6xtA+AeGsX8q46a/vi56Q2n1UxEfBq3f2Z2", "re"],
      "rib": ["sha384-Y9PAHBriWK3thU5RP5tkTneEVzAH3qcP4ldvzgqA205+7U/nZaC/GSXFGR6ybCyq"],
      "roboconf": ["sha384-Kg18whNRcEq0eoI3MF84wTO0/46d2Pq9l1auOhpsPxIbiGdSHZGgKdLO1od2jb2/", "graph", "instances"],
      "routeros": ["sha384-ajuBxp0NtXDv1Xdjv989GfmK+uavoptlyYIXEg966ePWjVbMXbgZ0bChnpyMiRC8", "mikrotik"],
      "rsl": ["sha384-jatQBVf5nbsaP5/qJ9Bdp4zWs6TotMw3hmoQirXbZDEAxFXU9IFaWdMVYuMKG5z2"],
      "ruleslanguage": ["sha384-CvTzW8GurTTZFukdcSTU+4fJzmJoJwPOl/W9UnfF8qM7ErYA6yf6aGHbe1u+X2nj"],
      "sas": ["sha384-cEGk4Mfg6EneDDCpBHTOJ4r9jfWL7RppF+K5mhKTCG73v0rvwVeUwHVlm50tPI4B"],
      "scala": ["sha384-VG8NRHHYMlILj7B8QIlb/1n4TKGng3TJrMaQMl9nzBwjaDyItiwrn73r4C5UKCIa"],
      "scheme": ["sha384-MAbum4IyUmlGkScyApilwRqISD/a/teYmeh67/ohQqHHwY0FlkeIvxWLxwdNXM2p", "scm"],
      "scilab": ["sha384-Q82i1VlFmTjhf383c6yY9OEgeOwjUJtvEenN+Lk8Dc4SP7s/UHEJghxeczwKsza1", "sci"],
      "smali": ["sha384-SwP9+7tfjY6eaDJx5cXBonHlYLgei8KYrvymAZwyNJpMleNf32L+nfzx8S9Q1dqE"],
      "smalltalk": ["sha384-O4jTNymoATmEaHXHatbt13fCiMA/teGzscJqFqR4te/q18s4nvEA20LFu67APL6D", "st"],
      "sml": ["sha384-br+dVIPmU7ygGUY9pPc4K6Yg8PMCmMiM9z8CJIZXIDJ/ZkH3lJT3Lv251+9hvLdY"],
      "sqf": ["sha384-LTi0wQ266XZXzauBrIPAm7jXQKv1q3aCJmHZae8hC9ocKs58mkFVjQYZy+HwRule"],
      "stan": ["sha384-Jp/Tby/bTJcbJQVsA5KSc8xRzeoZtyJ1staguX4TIUUjNoKX0vzGtAHQpp9wD+Oh", "stanfuncs"],
      "stata": ["sha384-gtPcLINB+T6I86+WPtzxHKRfZIoSZ57oMCSSPxKHGkbAJxf1Ej/UmpZcr1zbvRi0", "do", "ado"],
      "step21": ["sha384-BZ+EzK6BnRM2IgBQaheAPi9q3GbfTCBrd8tJspHOupr8tgNVEJsxC9ZhKkQFfz+b", "p21", "step", "stp"],
      "stylus": ["sha384-x/TbqfrW7rPeTk96dpU4gyJjGbUM5W4Cv3WUg9Ny8RWAbdz7pVIkj/irin942SF0", "styl"],
      "subunit": ["sha384-F12qqtW6Uta1QV3OjdiyN4uNdUT65eiEHJ3Dsth5jVODAvia09WSn8ZvgF12cWNl"],
      "taggerscript": ["sha384-Of+aTNxM1JBT0lUQz02y/6mtoNpdZ+AHfgrJx2TZCTo7iMs2KzOU/kUaCsnSJ+wg"],
      "tap": ["sha384-THv8RzHRGsPVkm5Aosm8PlZENAnOI2tSFMPp+v1EmdPwP1i8IgTygrDIRiGmDbgZ"],
      "tcl": ["sha384-gaTSb3tfBt1vHxiMbZMGtmjN3+VGzkxZ8+XJWUhKAaV2DU1lSkpDYyCijPTEah6W", "tk"],
      "thrift": ["sha384-y0SHMEogDMR3L++Cf6bLZLAAzwEvLJbcfV/mUq5e8850okEbp8JBV6UpQlk4qdl7"],
      "tp": ["sha384-E5rOF/NUGoswlHdqSJTi/H1MSFecY1dt1pil1Woze4I2SzVXPwD8VQ2B1NMy4M3D"],
      "twig": ["sha384-ubjLrFvQnlhlpJroRe+CA9XzoS8SFRuzy6uuaXmK2B5Kjzo0qz22tHv+9fJeywtI", "craftcms"],
      "vala": ["sha384-b0NWkEk2UDHmLEy5ZzWOAcoC9XH2RJ6L++TKpUlKITDnjkMvwFdxuqQvmziae4nB"],
      "vbscript-html": ["sha384-L1GVKH/XONTx/Ax4PfPpugJAYv6Vboz6EJHm7eYBBu56lE97DJWzYnxkvEMbjiqo"],
      "vbscript": ["sha384-F3PdTu1H9EQbf9+kaCgXMsK9KatSzkU8gN5BlM6zw+NwiN5HaUmcEjs/fQlgUf8P", "vbs"],
      "verilog": ["sha384-5ZV59wbyJuAPCpav8ZuzEZk3cxvbd/S6gn2EAnH7ddWVUeZIvrZJxW0ha/I6w7qX", "v", "sv", "svh"],
      "vhdl": ["sha384-+sYu5GECN54s/Mp9gH1yXTbbJ+gnuWz4SS9x/gwcxQM2JxziMXL7/w3XBsqbdDpl"],
      "vim": ["sha384-DTGwkXgxP7GFYuQl4t3iMY6owPfm43tBw2AH4LerV9I5DFgSRSDzAueQvoSykx2S"],
      "wren": ["sha384-Djdyfn6yiXDeNzomksrj7W2JUHC9nIKCxXXkc8sWARDrPKIPoro4mNfmjohwe0+g"],
      "x86asm": ["sha384-Cf3xzgfOHCjwxHFvuO1cpP6GHSth3EMwNXmQ1fdOonZL5fHRQx6cICV3YkQ74oVu"],
      "xl": ["sha384-u6Q+Pi3LdqRWgHdoXaOtnlJycAOOLQFVFtYUHQJeRxi9tAv2e9jx9Fbc4sp9lRlQ", "tao"],
      "xquery": ["sha384-IR0iQDtoTmp4mzKvzWSdhaICcHtYj6VxSAngMJNq0zTcuZYoCfy0V2sNIu1VfWN0", "xpath", "xq", "xqm"],
      "zephir": ["sha384-yYqQucQ02nhy4/ZBpTPz5h4/tonIYvtpNYL/9k8r5gueXol8ecDZGNRH6KqjEiIm", "zep"],
    },
  };
  // </hljs>

  // highlight.js's scopes, as the classes it writes, in the theme's colours.
  T.style(
    [
      '.hljs-comment, .hljs-quote { color: var(--t-code-comment); font-style: italic; }',
      '.hljs-keyword, .hljs-selector-tag, .hljs-doctag, .hljs-template-tag, .hljs-name, .hljs-variable.language_ { color: var(--t-code-keyword); }',
      '.hljs-string, .hljs-regexp, .hljs-link, .hljs-char.escape_, .hljs-meta .hljs-string { color: var(--t-code-string); }',
      '.hljs-number, .hljs-literal, .hljs-symbol, .hljs-bullet, .hljs-variable.constant_ { color: var(--t-code-number); }',
      '.hljs-title, .hljs-section { color: var(--t-code-function); }',
      '.hljs-type, .hljs-title.class_, .hljs-built_in, .hljs-selector-class { color: var(--t-code-type); }',
      '.hljs-variable, .hljs-template-variable, .hljs-attr, .hljs-attribute, .hljs-property, .hljs-selector-id, .hljs-selector-attr, .hljs-selector-pseudo { color: var(--t-code-variable); }',
      '.hljs-meta, .hljs-meta .hljs-keyword { color: var(--t-code-meta); }',
      '.hljs-addition { color: var(--t-code-inserted); }',
      '.hljs-deletion { color: var(--t-code-deleted); }',
      '.hljs-emphasis { font-style: italic; }',
      '.hljs-strong, .hljs-section { font-weight: 600; }',
    ].join('\n'),
  );

  const DOM = typeof document === 'object' && document !== null && document.nodeType === 9;
  if (!DOM) return;

  const opts = (T.config && T.config.use && T.config.use.code) || {};
  const own = typeof opts.base === 'string' && opts.base.trim() !== '';
  const base = own ? opts.base.trim().replace(/\/+$/, '') : `https://cdn.jsdelivr.net/npm/@highlightjs/cdn-assets@${HLJS.version}`;

  // A script with the page's nonce, and SRI unless it is the author's copy.
  function load(src, hash) {
    return new Promise((resolve) => {
      const s = document.createElement('script');
      if (T.config && T.config.nonce) s.nonce = T.config.nonce;
      if (!own) (s.integrity = hash), (s.crossOrigin = 'anonymous');
      s.async = true;
      s.src = src;
      s.onload = () => resolve(true);
      s.onerror = () => resolve(false);
      document.head.append(s);
    });
  }

  // highlight.js: the page's own, or the common bundle, asked for now so that
  // it loads alongside the add-ons and KaTeX rather than after the mount.
  // window.hljs can be an element with id="hljs", which the browser names on window.
  const found = () => (window.hljs && typeof window.hljs.highlight === 'function' ? window.hljs : null);
  const given = found();
  const core = given ? Promise.resolve(given) : load(`${base}/highlight.min.js`, HLJS.core).then((ok) => (ok && found()) || null);
  core.then((h) => h || console.warn(`Tern code.js: highlight.js did not load from ${base}, so code stays plain`));

  // A language the core lacks: its file, by name or alias, loaded once.
  const files = new Map();
  for (const [name, [, ...aliases]] of Object.entries(HLJS.languages)) for (const k of [name, ...aliases]) files.set(k, name);
  const loading = new Map();
  async function language(h, lang) {
    if (h.getLanguage(lang)) return lang;
    const name = !given && files.get(lang.toLowerCase());
    if (!name) return null;
    if (!loading.has(name)) loading.set(name, load(`${base}/languages/${name}.min.js`, HLJS.languages[name][0]));
    await loading.get(name);
    return h.getLanguage(lang) ? lang : null;
  }

  // Coloured markup cut at each newline into one fragment per line, the
  // spans open at a cut closed before it and reopened after.
  function split(root) {
    const lines = [];
    const path = [];
    let open = [];
    const top = () => (open.length ? open[open.length - 1] : lines[lines.length - 1]);
    const newLine = () => {
      lines.push(document.createDocumentFragment());
      open = [];
      for (const el of path) {
        const c = el.cloneNode(false);
        top().append(c);
        open.push(c);
      }
    };
    const visit = (node) => {
      if (node.nodeType === 3) {
        node.data.split('\n').forEach((part, i) => {
          if (i) newLine();
          if (part) top().append(part);
        });
      } else if (node.nodeType === 1) {
        const c = node.cloneNode(false);
        top().append(c);
        path.push(node);
        open.push(c);
        for (const k of node.childNodes) visit(k);
        path.pop();
        open.pop();
      }
    };
    newLine();
    for (const k of root.childNodes) visit(k);
    return lines;
  }

  async function paint(code, lang) {
    const h = await core;
    const id = h && (await language(h, lang));
    if (!id || !code.isConnected || code.querySelector('[class*="hljs-"]')) return;
    const lines = [...code.children].filter((c) => c.classList.contains('t-line'));
    let html;
    try {
      html = h.highlight(code.textContent, { language: id, ignoreIllegals: true }).value;
    } catch (e) {
      return; // a grammar that throws leaves the code plain
    }
    const t = document.createElement('template');
    t.innerHTML = html; // highlight.js escapes the code; its markup is spans
    if (!lines.length) return void code.replaceChildren(t.content);
    const parts = split(t.content);
    if (parts.length === lines.length) lines.forEach((line, i) => line.replaceChildren(parts[i]));
  }

  // Fences are pre[data-t=code], listings figure[data-t=code]; a fence with
  // no language, or a plain one, is left as it is.
  const PLAIN = new Set(['plaintext', 'text', 'txt', 'nohighlight', 'no-highlight']);
  T.define('code', (el) => {
    const code = el.matches('pre') ? el.querySelector(':scope > code') : el.querySelector('pre > code');
    const m = code && /(?:^|\s)language-(\S+)/.exec(code.className);
    if (m && !PLAIN.has(m[1].toLowerCase())) paint(code, m[1]);
  });
})();
