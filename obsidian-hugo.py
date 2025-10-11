import logging
import os
import re
import shutil
import sys

logging.basicConfig(level=logging.INFO)


def main(args: list):
    if len(args) != 4:
        raise Exception(
            "Invalid arguments. Format python script.py <obsidian-vault-path> <hugo-content-path> <hugo-static-path>")

    vault_path = args[1]
    hugo_content_path = args[2]
    hugo_static_path = args[3]

    copy_content(vault_path, hugo_content_path)
    replace_image_refs(hugo_content_path)
    replace_refs(hugo_content_path)
    copy_static_content(vault_path, hugo_static_path)


def copy_static_content(vault_path, hugo_static_path):
    static_folder = os.path.join(hugo_static_path, 'images')

    logging.info("Deleting: %s", static_folder)
    shutil.rmtree(static_folder, ignore_errors=True)
    logging.info("Recreating: %s", static_folder)
    os.makedirs(static_folder, exist_ok=True)

    for item in os.listdir(vault_path):
        src_path = os.path.join(vault_path, item)
        dst_path = os.path.join(static_folder, item)
        if src_path.endswith(".md") or os.path.isdir(src_path):
            continue
        logging.info("Copying: %s to %s", src_path, dst_path)
        if os.path.isfile(src_path):
            shutil.copy2(src_path, dst_path)


def copy_content(vault_path, content_path):
    posts_folder = os.path.join(content_path, 'posts')

    logging.info("Deleting: %s", posts_folder)
    shutil.rmtree(posts_folder, ignore_errors=True)
    logging.info("Recreating: %s", posts_folder)
    os.makedirs(posts_folder, exist_ok=True)

    for item in os.listdir(vault_path):
        src_path = os.path.join(vault_path, item)
        dst_path = os.path.join(posts_folder, item)
        if not src_path.endswith(".md"):
            continue
        logging.info("Copying: %s to %s", src_path, dst_path)
        if os.path.isfile(src_path):
            shutil.copy2(src_path, dst_path)


def replace_image_refs(content_path):
    # Pattern to match ![[filename]] where filename can be anything not including ]]
    folder_path = os.path.join(content_path, 'posts')
    pattern = re.compile(r'!\[\[(.+?)\]\]')

    for filename in os.listdir(folder_path):
        file_path = os.path.join(folder_path, filename)
        if os.path.isfile(file_path):
            with open(file_path, 'r', encoding='utf-8') as file:
                content = file.read()

            # Replace ![[filename]] with ![Image](/images/filename)
            updated_content = pattern.sub(r'![Image](/images/\1)', content)

            with open(file_path, 'w', encoding='utf-8') as file:
                file.write(updated_content)


def replace_refs(content_path):
    folder_path = os.path.join(content_path, 'posts')
    pattern = re.compile(r'\[\[(.+?)\]\]')  # Match [[Content]] pattern non-greedily

    for filename in os.listdir(folder_path):
        file_path = os.path.join(folder_path, filename)
        if os.path.isfile(file_path):
            with open(file_path, 'r', encoding='utf-8') as file:
                content = file.read()

            # Replace using regex substitution with captured group
            updated_content = pattern.sub(r'[\1]({{< ref "\1" >}})', content)

            with open(file_path, 'w', encoding='utf-8') as file:
                file.write(updated_content)


if __name__ == "__main__":
    main(sys.argv)
