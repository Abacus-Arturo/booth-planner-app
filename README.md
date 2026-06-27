# Booth Planner

Editor 3D de planeación de booths/backdrops (React + Three.js), para correr fuera del sandbox de Claude y poder cargar modelos reales desde GitHub sin restricciones de red.

## Desarrollo local (opcional)

```bash
npm install
npm run dev
```

Abre `http://localhost:5173`.

## Desplegar en GitHub Pages

1. **Sube este proyecto a un repo de GitHub** (puede ser el mismo `booth-planner-library` o uno nuevo, ej. `booth-planner-app`):
   ```bash
   git init
   git add .
   git commit -m "Initial commit"
   git branch -M main
   git remote add origin https://github.com/TU-USUARIO/NOMBRE-DEL-REPO.git
   git push -u origin main
   ```

2. **Activa GitHub Pages con GitHub Actions:**
   - Ve a tu repo en github.com -> Settings -> Pages
   - En "Build and deployment" -> Source, selecciona "GitHub Actions" (no "Deploy from a branch")

3. **Listo.** El workflow en `.github/workflows/deploy.yml` se dispara automatico con cada push a main. La primera vez tarda ~1-2 minutos en construir y publicar.

4. Tu sitio queda en:
   ```
   https://TU-USUARIO.github.io/NOMBRE-DEL-REPO/
   ```
   (revisa la pestana Actions del repo para ver el progreso del deploy, y la URL final aparece en Settings -> Pages una vez que termina)

## Cargar tu libreria de modelos

Una vez abierto el sitio, pega la URL de tu manifest.json en el campo "URL de manifest" del sidebar y dale "Cargar libreria". Por ejemplo:
```
https://raw.githubusercontent.com/Abacus-Arturo/booth-planner-library/main/models/manifest.json
```

Aqui, fuera del sandbox de artifacts, el fetch() a tus .glb deberia funcionar sin el bloqueo de red que veiamos en Claude.
