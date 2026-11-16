// Índice lateral das páginas longas e marcação da parte em leitura.
// O índice só aparece em tela larga (regra no CSS); a marcação vale também
// para o menu "Seções" do topo. Usado pela página principal e pela de
// metodologia.

// grupos: [{ titulo, links: [{ texto, href }] }]; titulo pode faltar.
export function montarIndice(nav, grupos) {
  for (const { titulo, links } of grupos) {
    const caixa = document.createElement('div');
    caixa.className = 'indice-grupo';
    if (titulo) {
      const p = document.createElement('p');
      p.className = 'indice-titulo';
      p.textContent = titulo;
      caixa.append(p);
    }
    const lista = document.createElement('ul');
    for (const { texto, href } of links) {
      const a = document.createElement('a');
      a.href = href;
      a.textContent = texto;
      const li = document.createElement('li');
      li.append(a);
      lista.append(li);
    }
    caixa.append(lista);
    nav.append(caixa);
  }
  nav.hidden = false;
}

// Marca com aria-current os links da parte em leitura: a última, na ordem
// da página, cujo começo já passou de 40% da altura da tela. No fim da
// página, a última parte, que pode nunca chegar tão alto. Se o índice tiver
// rolagem própria, ele rola até o link marcado.
export function acompanharLeitura(links, alvos, nav) {
  let marcada;
  const marcar = () => {
    const visiveis = alvos.filter((a) => a.getClientRects().length);
    const noFim = innerHeight + scrollY >= document.documentElement.scrollHeight - 4;
    const linha = innerHeight * 0.4;
    let atual = null;
    if (noFim) atual = visiveis[visiveis.length - 1] ?? null;
    else {
      for (const a of visiveis) if (a.getBoundingClientRect().top <= linha) atual = a;
    }
    const id = atual?.id ?? null;
    if (id === marcada) return;
    marcada = id;
    for (const a of links) {
      if (id && a.getAttribute('href').endsWith(`#${id}`)) a.setAttribute('aria-current', 'true');
      else a.removeAttribute('aria-current');
    }
    const marcado = nav?.querySelector('a[aria-current="true"]');
    if (marcado && nav.scrollHeight > nav.clientHeight) {
      const topo = marcado.offsetTop;
      if (topo < nav.scrollTop || topo + marcado.offsetHeight > nav.scrollTop + nav.clientHeight) {
        nav.scrollTop = topo - nav.clientHeight / 3;
      }
    }
  };
  let pendente = false;
  const agendar = () => {
    if (pendente) return;
    pendente = true;
    requestAnimationFrame(() => { pendente = false; marcar(); });
  };
  addEventListener('scroll', agendar, { passive: true });
  addEventListener('resize', agendar);
  marcar();
  return agendar;
}
