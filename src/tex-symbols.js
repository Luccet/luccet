// SPDX-License-Identifier: MIT
// TeX's math symbols for src/tex.js: each command's character and its class
// in TeX's spacing (mi: an ordinary symbol written as <mi>; ord: one written
// as <mo> without space; bin, rel, open, close, punct, inner; op and opn: large
// operators with limits above and below, or beside). The command list follows
// what KaTeX and Temml accept, as a list of LaTeX's names and Unicode's
// characters; Temml's table (MIT, github.com/ronkok/Temml) was the checklist.
//
// Each list is "name char" pairs, separated by spaces.
'use strict';

// Ordinary symbols, written as <mi>: letters and letter-like symbols.
const MI =
  "# # & & aleph ℵ forall ∀ hbar ℏ exists ∃ nabla ∇ flat ♭ ell ℓ natural ♮ clubsuit ♣ varclubsuit ♧ " +
  "wp ℘ sharp ♯ diamondsuit ♢ vardiamondsuit ♦ Re ℜ heartsuit ♡ varheartsuit ♥ Im ℑ spadesuit ♠ " +
  "varspadesuit ♤ S § P ¶ dag † ddag ‡ QED ∎ permil ‰ hslash ℏ triangledown ▽ lozenge ◊ circledS Ⓢ " +
  "circledR ® measuredangle ∡ nexists ∄ mho ℧ Finv Ⅎ Game ⅁ backprime ‵ backdprime ‶ backtrprime ‷ " +
  "blacktriangle ▲ blacktriangledown ▼ blacksquare ■ blacklozenge ⧫ bigstar ★ sphericalangle ∢ " +
  "complement ∁ diagup ╱ diagdown ╲ square □ Box □ Diamond ◊ yen ¥ checkmark ✓ ballotx ✗ beth ℶ " +
  "daleth ℸ gimel ℷ digamma ϝ varkappa ϰ triangle △ $ $ cent ¢ % % _ _ angle ∠ infty ∞ prime ′ " +
  "dprime ″ trprime ‴ qprime ⁗ Alpha Α Beta Β Gamma Γ Delta Δ Epsilon Ε Zeta Ζ Eta Η Theta Θ Iota Ι " +
  "Kappa Κ Lambda Λ Mu Μ Nu Ν Xi Ξ Omicron Ο Pi Π Rho Ρ Sigma Σ Tau Τ Upsilon Υ Phi Φ Chi Χ Psi Ψ " +
  "Omega Ω neg ¬ lnot ¬ top ⊤ bot ⊥ emptyset ∅ varnothing ⌀ alpha α beta β gamma γ delta δ " +
  "epsilon ϵ zeta ζ eta η theta θ iota ι kappa κ lambda λ mu μ nu ν xi ξ omicron ο pi π rho ρ " +
  "sigma σ tau τ upsilon υ phi ϕ chi χ psi ψ omega ω varepsilon ε vartheta ϑ varpi ϖ varrho ϱ " +
  "varsigma ς varphi φ Bot ⫫ eth ð AA Å AE Æ DH Ð TH Þ ss ß aa å ae æ dh ð th þ DJ Đ dj đ L Ł l ł " +
  "NG Ŋ ng ŋ OE Œ oe œ partial ∂ varvdots ⋮ imath ı jmath ȷ o ø O Ø degree ° pounds £ maltese ✠ " +
  "euro € copyright © diameter ⌀ varGamma 𝛤 varDelta 𝛥 varTheta 𝛩 varLambda 𝛬 varXi 𝛯 varPi 𝛱 " +
  "varSigma 𝛴 varUpsilon 𝛶 varPhi 𝛷 varPsi 𝛹 varOmega 𝛺 vdots ⋮ surd √";

// Ordinary symbols written as <mo> with no space either side: bars and slashes, which \left can stretch.
const ORD =
  "backslash \\ vert | | ‖ Vert ‖";

// Binary operators.
const BIN =
  "mp ∓ ominus ⊖ uplus ⊎ sqcap ⊓ ast ∗ sqcup ⊔ bigcirc ◯ bullet ∙ ddagger ‡ wr ≀ amalg ⨿ And & " +
  "sslash ⫽ unlhd ⊴ unrhd ⊵ lessdot ⋖ gtrdot ⋗ lhd ⊲ rhd ⊳ dotplus ∔ smallsetminus ∖ Cap ⋒ Cup ⋓ " +
  "doublebarwedge ⩞ boxminus ⊟ boxplus ⊞ boxslash ⧄ divideontimes ⋇ ltimes ⋉ rtimes ⋊ " +
  "leftthreetimes ⋋ rightthreetimes ⋌ curlywedge ⋏ curlyvee ⋎ circleddash ⊝ circledast ⊛ intercal ⊺ " +
  "doublecap ⋒ doublecup ⋓ boxtimes ⊠ bowtie ⋈ Join ⋈ leftouterjoin ⟕ rightouterjoin ⟖ " +
  "fullouterjoin ⟗ dotminus ∸ wedgedot ⟑ veedot ⟇ doublebarvee ⩢ veedoublebar ⩣ wedgebar ⩟ " +
  "wedgedoublebar ⩠ Vee ⩔ Wedge ⩓ barcap ⩃ barcup ⩂ capbarcup ⩈ capdot ⩀ capovercup ⩇ cupovercap ⩆ " +
  "closedvarcap ⩍ closedvarcup ⩌ minusdot ⨪ minusfdots ⨫ minusrdots ⨬ Xor ⊻ Nand ⊼ Nor ⊽ barvee ⊽ " +
  "interleave ⫴ shuffle ⧢ threedotcolon ⫶ typecolon ⦂ invlazys ∾ twocaps ⩋ twocups ⩊ Sqcap ⩎ " +
  "Sqcup ⩏ veeonvee ⩖ wedgeonwedge ⩕ blackhourglass ⧗ boxast ⧆ boxbox ⧈ boxcircle ⧇ circledequal ⊜ " +
  "circledparallel ⦷ circledvert ⦶ circlehbar ⦵ concavediamond ⟡ concavediamondtickleft ⟢ " +
  "concavediamondtickright ⟣ diamond ⋄ hourglass ⧖ lozengeminus ⟠ obar ⌽ obslash ⦸ odiv ⨸ " +
  "ogreaterthan ⧁ olessthan ⧀ operp ⦹ Otimes ⨷ otimeshat ⨶ star ⋆ triangleminus ⨺ triangleplus ⨹ " +
  "triangletimes ⨻ whitesquaretickleft ⟤ whitesquaretickright ⟥ smashtimes ⨳ cdot ⋅ circ ∘ div ÷ " +
  "pm ± times × cap ∩ cup ∪ setminus ∖ land ∧ lor ∨ wedge ∧ vee ∨ barwedge ⊼ veebar ⊻ odot ⊙ " +
  "oplus ⊕ otimes ⊗ oslash ⊘ circledcirc ⊚ boxdot ⊡ bigtriangleup △ bigtriangledown ▽ dagger † " +
  "triangleleft ◃ triangleright ▹";

// Relations, arrows among them.
const REL =
  "equiv ≡ prec ≺ succ ≻ sim ∼ perp ⟂ preceq ⪯ succeq ⪰ simeq ≃ backcong ≌ mid ∣ ll ≪ gg ≫ asymp ≍ " +
  "parallel ∥ smile ⌣ sqsubseteq ⊑ sqsupseteq ⊒ doteq ≐ frown ⌢ ni ∋ notni ∌ propto ∝ vdash ⊢ " +
  "dashv ⊣ owns ∋ arceq ≘ wedgeq ≙ veeeq ≚ stareq ≛ eqdef ≝ measeq ≞ questeq ≟ ne ≠ neq ≠ eqeq ⩵ " +
  "eqeqeq ⩶ dblcolon ∷ coloneqq ≔ eqqcolon ≕ eqcolon ∹ Coloneqq ⩴ longleftarrow ⟵ Leftarrow ⇐ " +
  "Longleftarrow ⟸ longrightarrow ⟶ Rightarrow ⇒ Longrightarrow ⟹ leftrightarrow ↔ " +
  "longleftrightarrow ⟷ Leftrightarrow ⇔ Longleftrightarrow ⟺ mapsfrom ↤ mapsto ↦ longmapsto ⟼ " +
  "nearrow ↗ hookleftarrow ↩ hookrightarrow ↪ searrow ↘ leftharpoonup ↼ rightharpoonup ⇀ swarrow ↙ " +
  "leftharpoondown ↽ rightharpoondown ⇁ nwarrow ↖ rightleftharpoons ⇌ nless ≮ lneq ⪇ lneqq ≨ " +
  "lvertneqq ≨︀ lnsim ⋦ lnapprox ⪉ nprec ⊀ npreceq ⋠ precnsim ⋨ precnapprox ⪹ nsim ≁ nmid ∤ " +
  "nshortmid ∤ nvdash ⊬ nvDash ⊭ ntriangleleft ⋪ ntrianglelefteq ⋬ nsubset ⊄ nsupset ⊅ subsetneq ⊊ " +
  "varsubsetneq ⊊︀ subsetneqq ⫋ varsubsetneqq ⫋︀ ngtr ≯ gneq ⪈ gneqq ≩ gvertneqq ≩︀ gnsim ⋧ " +
  "gnapprox ⪊ nsucc ⊁ nsucceq ⋡ succnsim ⋩ succnapprox ⪺ ncong ≆ nparallel ∦ nshortparallel ∦ " +
  "nVDash ⊯ ntriangleright ⋫ ntrianglerighteq ⋭ supsetneq ⊋ varsupsetneq ⊋ supsetneqq ⫌ " +
  "varsupsetneqq ⫌︀ nVdash ⊮ precneqq ⪵ succneqq ⪶ nleftarrow ↚ nrightarrow ↛ nLeftarrow ⇍ " +
  "nRightarrow ⇏ nleftrightarrow ↮ nLeftrightarrow ⇎ vartriangle △ leqq ≦ leqslant ⩽ eqslantless ⪕ " +
  "lesssim ≲ lessapprox ⪅ approxeq ≊ lll ⋘ lessgtr ≶ lesseqgtr ⋚ lesseqqgtr ⪋ doteqdot ≑ " +
  "risingdotseq ≓ fallingdotseq ≒ backsim ∽ backsimeq ⋍ subseteqq ⫅ Subset ⋐ sqsubset ⊏ " +
  "preccurlyeq ≼ curlyeqprec ⋞ precsim ≾ precapprox ⪷ vartriangleleft ⊲ trianglelefteq ⊴ vDash ⊨ " +
  "VDash ⊫ Vvdash ⊪ smallsmile ⌣ smallfrown ⌢ bumpeq ≏ Bumpeq ≎ geqq ≧ geqslant ⩾ eqslantgtr ⪖ " +
  "gtrsim ≳ gtrapprox ⪆ ggg ⋙ gtrless ≷ gtreqless ⋛ gtreqqless ⪌ eqcirc ≖ circeq ≗ triangleq ≜ " +
  "thicksim ∼ thickapprox ≈ supseteqq ⫆ Supset ⋑ sqsupset ⊐ succcurlyeq ≽ curlyeqsucc ⋟ succsim ≿ " +
  "succapprox ⪸ vartriangleright ⊳ trianglerighteq ⊵ Vdash ⊩ shortmid ∣ shortparallel ∥ between ≬ " +
  "pitchfork ⋔ varpropto ∝ blacktriangleleft ◀ therefore ∴ backepsilon ∍ blacktriangleright ▶ " +
  "because ∵ llless ⋘ gggtr ⋙ eqsim ≂ Doteq ≑ strictif ⥽ strictfi ⥼ dashrightarrow ⇢ " +
  "dashleftarrow ⇠ leftleftarrows ⇇ leftrightarrows ⇆ Lleftarrow ⇚ twoheadleftarrow ↞ " +
  "leftarrowtail ↢ looparrowleft ↫ leftrightharpoons ⇋ curvearrowleft ↶ circlearrowleft ↺ Lsh ↰ " +
  "upuparrows ⇈ upharpoonleft ↿ downharpoonleft ⇃ origof ⊶ imageof ⊷ multimap ⊸ " +
  "leftrightsquigarrow ↭ rightrightarrows ⇉ rightleftarrows ⇄ twoheadrightarrow ↠ rightarrowtail ↣ " +
  "looparrowright ↬ curvearrowright ↷ circlearrowright ↻ Rsh ↱ downdownarrows ⇊ upharpoonright ↾ " +
  "downharpoonright ⇂ rightsquigarrow ⇝ leadsto ⇝ Rrightarrow ⇛ restriction ↾ equal = approx ≈ " +
  "cong ≅ ge ≥ geq ≥ gets ← gt > in ∈ notin ∉ subset ⊂ supset ⊃ subseteq ⊆ supseteq ⊇ nsubseteq ⊈ " +
  "nsubseteqq ⊈ nsupseteq ⊉ nsupseteqq ⊉ models ⊨ leftarrow ← le ≤ leq ≤ lt < rightarrow → to → " +
  "ngeq ≱ ngeqq ≱ ngeqslant ≱ nleq ≰ nleqq ≰ nleqslant ≰ Perp ⫫ uparrow ↑ Uparrow ⇑ downarrow ↓ " +
  "Downarrow ⇓ updownarrow ↕ Updownarrow ⇕";

// Opening delimiters.
const OPEN =
  "lmoustache ⎰ lgroup ⟮ ulcorner ⌜ llcorner ⌞ llbracket ⟦ langle ⟨ lAngle ⟪ llangle ⦉ lvert | " +
  "lVert ‖ lBrace ⦃ { { lbrace { lbrack [ lparen ( llparenthesis ⦇ lfloor ⌊ lceil ⌈";

// Closing delimiters.
const CLOSE =
  "rmoustache ⎱ rgroup ⟯ urcorner ⌝ lrcorner ⌟ rrbracket ⟧ rangle ⟩ rAngle ⟫ rrangle ⦊ rvert | " +
  "rVert ‖ rBrace ⦄ } } rbrace } rbrack ] rparen ) rrparenthesis ⦈ rfloor ⌋ rceil ⌉";

// Punctuation.
const PUNCT =
  "colon :";

// Dots (TeX's inner class).
const INNER =
  "mathellipsis … dotso … dotsc … ldots … iddots ⋰ cdots ⋯ ddots ⋱ dots … hdots …";

// Large operators that take their limits above and below in display style.
const OP =
  "coprod ∐ bigvee ⋁ bigwedge ⋀ biguplus ⨄ bigcupplus ⨄ bigcupdot ⨃ bigdoublevee ⨇ bigdoublewedge ⨈ " +
  "bigcap ⋂ bigcup ⋃ intop ∫ prod ∏ sum ∑ bigotimes ⨂ bigoplus ⨁ bigodot ⨀ bigtimes ⨉ bigsqcap ⨅ " +
  "bigsqcup ⨆";

// Large operators that keep their limits beside them (the integrals).
const OPN =
  "int ∫ iint ∬ iiint ∭ oint ∮ oiint ∯ oiiint ∰ intclockwise ∱ varointclockwise ∲ iiiint ⨌ intbar ⨍ " +
  "intBar ⨎ fint ⨏ rppolint ⨒ scpolint ⨓ pointint ⨕ sqint ⨖ intlarhk ⨗ intx ⨘ intcap ⨙ intcup ⨚ " +
  "smallint ∫";

// Text-mode symbols, in \text{…}.
const TEXT =
  "# # & & S § P ¶ dag † textdagger † ddag ‡ textdaggerdbl ‡ permil ‰ circledR ® textregistered ® " +
  "yen ¥ checkmark ✓ ballotx ✗ textbullet • $ $ textdollar $ cent ¢ % % _ _ textunderscore _ " +
  "textvisiblespace ␣ Alpha Α Beta Β Gamma Γ Delta Δ Epsilon Ε Zeta Ζ Eta Η Theta Θ Iota Ι Kappa Κ " +
  "Lambda Λ Mu Μ Nu Ν Xi Ξ Omicron Ο Pi Π Rho Ρ Sigma Σ Tau Τ Upsilon Υ Phi Φ Chi Χ Psi Ψ Omega Ω " +
  "AA Å AE Æ DH Ð TH Þ ss ß aa å ae æ dh ð th þ DJ Đ dj đ L Ł l ł NG Ŋ ng ŋ OE Œ oe œ { { " +
  "textbraceleft { } } textbraceright } lbrack [ rbrack ] textless < textgreater > textbar | " +
  "textbardbl ‖ textasciitilde ~ textbackslash \\ textasciicircum ^ textellipsis … ldots … " +
  "varvdots ⋮ i ı j ȷ o ø O Ø textendash – textemdash — textquoteleft ‘ textquoteright ’ " +
  "textquotedblleft “ textquotedblright ” degree ° textdegree ° pounds £ textsterling £ maltese ✠ " +
  "euro € texteuro € textcopyright © diameter ⌀ varGamma 𝛤 varDelta 𝛥 varTheta 𝛩 varLambda 𝛬 " +
  "varXi 𝛯 varPi 𝛱 varSigma 𝛴 varUpsilon 𝛶 varPhi 𝛷 varPsi 𝛹 varOmega 𝛺";

// name -> [class, char]; char -> class, for a symbol typed as itself.
const symbols = new Map();
const classes = new Map();
for (const [k, list] of Object.entries({ mi: MI, ord: ORD, bin: BIN, rel: REL, open: OPEN, close: CLOSE, punct: PUNCT, inner: INNER, op: OP, opn: OPN })) {
  const parts = list.split(' ');
  for (let i = 0; i + 1 < parts.length; i += 2) {
    symbols.set(parts[i], [k, parts[i + 1]]);
    if (!classes.has(parts[i + 1])) classes.set(parts[i + 1], k);
  }
}
const text = new Map();
const parts = TEXT.split(' ');
for (let i = 0; i + 1 < parts.length; i += 2) text.set(parts[i], parts[i + 1]);

module.exports = { symbols, classes, text };
