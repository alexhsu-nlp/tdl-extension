# tdl-extension

This is an experimental VSCode extension of Type Definition Language (TDL) files used in [DELPH-IN](https://delph-in.github.io/docs/home/Home/) for computational linguistic processing with HPSG and MRS analysis. The syntax of TDL files can be viewed [here](https://delph-in.github.io/docs/tools/TdlRFC/). It is still under development -- usable, but expect a lot of bugs, and the speed is not satisfactory for large grammars such as [ERG](https://github.com/delph-in/erg) (mainly due to the large `lexicon.tdl`), but should be sufficient for grammars generated from the [Grammar Matrix](https://github.com/delph-in/matrix).

The extension currently supports (assuming type and feature names are of ascii characters only):

- Syntactic Highlights: comments, strings, type docstrings, brackets, definition operator (DEFOP, `:=`), multiple inheritance operator (AND, `&`), tag variables;
- Semantic Highlights of defined types (except for `*top*`);
- Go-to definitions of defined types with docstring display on hovering;
- Autocompletion of types and features based on attribute paths (buggy);
- Automatic indentation upon newline (buggy).

### Setup

#### Locally
- Install nvm. [This website](https://heynode.com/tutorial/install-nodejs-locally-nvm/) serves as a good tutorial. Alternatively, the docker file (see below) should contain similar information.
- Install node modules and compile typescript files:
```
$ cd /path/to/tdl/extension/directory
$ npm install
$ npm run compile
```
- Press `F5` (maybe you need to select `extension.ts` in the primary side bar before doing so) to start the Extension Development Host in VSCode.

#### Inside Docker Container
- The [docker file](https://github.com/alexhsu-nlp/tdl-extension/blob/main/Dockerfile) in the repo should provide a good start. Make sure to modify the following code to specify your own local directory of the extension:
```
# NOTE: type your own directory here
# WORKDIR /path/to/your/extension/directory
```
- Build the docker image and container. Note that we need to specifiy the grammar folder (or any folder that contains it) as the workspace:
```
$ cd /path/to/tdl/extension/directory
$ docker build -t your-image-name .
$ docker run -it --name your-container-name -v /your/grammar/folder:/home/dockeruser/workspace your-image-name
```
- Inside VSCode, press `F1` and select **Dev Containers: Attach to Running Container ...**
- Select "Open Folder..." and select or type the folder you typed as `WORKDIR` above.
- Press `F5` (maybe you need to select `extension.ts` in the primary side bar before doing so) to start the Extension Development Host in VSCode. to start the Extension Development Host.
- Select `/home/dockeruser/workspace` as the workspace inside the development host.
- You can start programming now.
