(ns io.github.getcolors.mysql-agy.utils
  "Launcher contract, node topology, and shared derivations for mysql-agy."
  (:require [clojure.string :as str]
            [green.cli :as green-cli]))

(def contract
  "Minimum mysql-agy contract a standalone launcher must find."
  1)

(defn node-count [opts]
  (let [n (:cluster-nodes opts)]
    (if (integer? n) n 3)))

(defn ordinals [opts]
  (range 1 (inc (node-count opts))))

(defn node-name
  "The DigitalOcean droplet name for member `ordinal`, and the Ansible
  inventory host alias."
  [opts ordinal]
  (str (:digitalocean-name opts) "-node-" ordinal))

(defn node-names [opts]
  (mapv #(node-name opts %) (ordinals opts)))

(defn server-id
  "MySQL server_id derived from the ordinal."
  [ordinal]
  (+ 100 ordinal))

(defn connection-server-id
  "The pseudo-replica id mysqlbinlog registers with."
  [ordinal]
  (+ 200 ordinal))

(defn node-host
  "Per-member administrative FQDN."
  [opts ordinal]
  (str "node-" ordinal "." (:cluster-host opts)))

(defn record-name
  "Cloudflare DNS record name without trailing dot."
  [host]
  (str/replace (str host) #"\.$" ""))

(defn tool-dir [opts tool]
  (green-cli/stage-dir opts tool {:default-profile "mysql-agy"}))

(defn backup-prefix
  "Object-key prefix inside the backup bucket, without trailing slashes."
  [opts]
  (str/replace (str (:backup-r2-prefix opts)) #"/+$" ""))

(def ^:private duration-re #"^[0-9]+(?:ms|s|m|h|min|d)$")

(defn duration? [x]
  (boolean (and (string? x) (re-matches duration-re x))))
